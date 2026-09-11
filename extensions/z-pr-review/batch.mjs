// I4: the lane batch — runs a mode's topology concurrently under the config
// budgets. Every decision here is code-owned: attempt plans (tier model, then
// one configured fallback), deadline math (tier attempt cap intersected with
// the batch window and the total hard cap), and lifecycle classification.
// Model text never influences any of it (spec: "Degradation and budgets").
import { drainUnconfirmedStops, runLane } from "./lane.mjs";

// One lane's attempt plan: the tier's model under the tier's attempt cap,
// then (if configured) the tier's fallback model under fallbackMs. Upstream
// classifies retryability finely (rate limits, quota, overload); our child
// events do not carry that yet, so every failed attempt is retryable once via
// the fallback and the attempt record discloses what ran. Richer
// classification arrives with telemetry (I8).
function attemptPlan(lane, config) {
  const tier = config.tiers[lane.tier];
  const plan = [{ model: tier.model ?? null, capMs: config.deadlines.attemptMs[lane.tier], label: "primary" }];
  if (tier.fallback !== undefined) {
    plan.push({ model: tier.fallback, capMs: config.deadlines.fallbackMs, label: "fallback" });
  }
  return plan;
}

async function runLaneUnderBudget({
  lane,
  envelope,
  config,
  repoRoot,
  cliPath,
  createRuntime,
  batchEndAt,
  totalEndAt,
  signal,
}) {
  const hardEndAt = Math.min(batchEndAt, totalEndAt);
  const attempts = [];
  for (const attempt of attemptPlan(lane, config)) {
    const remaining = hardEndAt - Date.now();
    if (signal?.aborted || remaining <= 0) {
      attempts.push({
        model: attempt.model,
        label: attempt.label,
        status: "failed",
        reason: signal?.aborted ? "cancelled before dispatch" : "budget expired before dispatch",
      });
      break;
    }
    let outcome = await runLane({
      lane,
      envelope,
      config,
      repoRoot,
      cliPath,
      deadlineAt: Math.min(Date.now() + attempt.capMs, hardEndAt),
      modelOverride: attempt.model,
      signal,
      createRuntime,
    }).catch((error) => {
      // A child-runtime startup failure (spawn, auth, SDK construction) is a
      // failed lane attempt, never a batch-wide rejection: sibling lanes keep
      // their classification and the report stays an incomplete-review
      // disclosure instead of disappearing. An error carrying a cleanup status
      // (a creation whose late child could not be confirmed stopped) keeps it,
      // so the fallback-skip rule below applies.
      const failed = {
        status: "failed",
        reason: `lane error: ${String(error?.message ?? error)}`,
        cleanup: error?.cleanup,
        findings: [],
        dropped: [],
        laneText: "",
        laneId: lane.id,
        tier: lane.tier,
      };
      return failed;
    });
    // A completed lane whose child cleanup timed out or failed is NOT a
    // completed lane: its findings are not claimed and the run is disclosed
    // as incomplete (one live runtime per lane — a lane that did not shut its
    // child down cleanly did not cleanly finish).
    if (outcome.status === "complete" && (outcome.cleanup === "timed-out" || outcome.cleanup === "failed")) {
      outcome = {
        ...outcome,
        status: "failed",
        reason: `child cleanup ${outcome.cleanup} after lane completion`,
        findings: [],
        dropped: [],
      };
    }
    // A prior child whose stop failed or hung must not be walked over by a
    // fallback attempt: one live runtime per lane, so an unresolved cleanup
    // ends the lane (disclosed) instead of risking two live children.
    const reason = outcome.cleanup === "timed-out" || outcome.cleanup === "failed"
      ? `${outcome.reason}; child cleanup ${outcome.cleanup}, fallback skipped`
      : outcome.reason;
    attempts.push({
      model: attempt.model,
      label: attempt.label,
      status: outcome.status,
      reason: outcome.status === "complete" ? undefined : reason,
    });
    if (outcome.status === "complete") return { ...outcome, attempts };
    if (reason !== outcome.reason) {
      return { ...outcome, reason, findings: [], dropped: [], attempts };
    }
  }
  const last = attempts.at(-1);
  return {
    status: "failed",
    reason: last?.reason ?? "no attempt dispatched",
    findings: [],
    dropped: [],
    laneText: "",
    laneId: lane.id,
    tier: lane.tier,
    attempts,
  };
}

// Classifies a finished batch: complete only when every lane completed.
// Anything less is disclosed — an incomplete run can never read as a clean
// review (spec: "Degradation and budgets").
export function batchStatus(laneResults) {
  const failed = laneResults.filter((result) => result.status !== "complete");
  if (failed.length === 0) return { status: "complete" };
  const incomplete = failed.map((result) => `${result.laneId} (${result.reason})`).join("; ");
  if (failed.length === laneResults.length) {
    return { status: "failed", reason: `every lane failed: ${incomplete}` };
  }
  const lanes = `${laneResults.length} lane${laneResults.length === 1 ? "" : "s"}`;
  return { status: "partial", reason: `${failed.length} of ${lanes} failed: ${incomplete}` };
}

// Runs the mode's lanes concurrently (concurrency = topology size, upstream
// semantics). The batch window (batchMs) opens at first dispatch and the
// total cap (totalMs) bounds the whole run including cleanup; both clip every
// attempt deadline. `signal` cancels every not-yet-finished lane; progress is
// reported per lane through onLaneDone as each settles.
export async function runLaneBatch({
  mode,
  lanes,
  envelope,
  config,
  repoRoot,
  cliPath,
  createRuntime,
  onLaneDone = null,
  signal = null,
}) {
  if (lanes.length === 0) {
    throw new Error(`review mode "${mode}" has an empty topology`);
  }
  const startedAt = Date.now();
  const batchEndAt = startedAt + config.deadlines.batchMs;
  const totalEndAt = startedAt + config.deadlines.totalMs;
  const laneResults = await Promise.all(
    lanes.map(async (lane) => {
      const result = await runLaneUnderBudget({
        lane,
        envelope,
        config,
        repoRoot,
        cliPath,
        createRuntime,
        batchEndAt,
        totalEndAt,
        signal,
      });
      if (onLaneDone) {
        // Progress reporting is not a lane result: a throwing or hanging
        // onLaneDone is recorded on the lane (disclosed) instead of rejecting
        // the batch or holding it past the total budget. The callback is
        // bounded by totalEndAt — never awaited beyond the review's hard cap.
        const PROGRESS_TIMEOUT = Symbol("progress-timeout");
        let progressTimer;
        try {
          const reported = await Promise.race([
            Promise.resolve(onLaneDone(lane, result)),
            new Promise((resolve) => {
              progressTimer = setTimeout(() => resolve(PROGRESS_TIMEOUT), Math.max(1, totalEndAt - Date.now()));
            }),
          ]);
          if (reported === PROGRESS_TIMEOUT) {
            result.progressError = "progress reporting exceeded the total budget; not awaited further";
          }
        } catch (error) {
          result.progressError = `progress reporting failed: ${String(error?.message ?? error)}`;
        } finally {
          clearTimeout(progressTimer);
        }
      }
      return result;
    }),
  );
  // Stops whose bounded grace expired during the batch keep running
  // best-effort; one final bounded sweep retires any that settled since. The
  // sweep deadline is clipped to the batch and total budgets — the caps bound
  // the whole run including this sweep, so it never adds time past them. What
  // still remains is reported, not hidden — a hung child runtime is never
  // silently forgotten.
  const unconfirmedStops = await drainUnconfirmedStops(
    Math.min(Date.now() + FINAL_STOP_SWEEP_MS, batchEndAt, totalEndAt),
  );
  return {
    mode,
    lanes: laneResults,
    elapsedMs: Date.now() - startedAt,
    ...(unconfirmedStops > 0 ? { unconfirmedStops } : {}),
    ...batchStatus(laneResults),
  };
}

// The end-of-batch sweep is deliberately short: each stop already had its full
// clipped grace inside its attempt, so this only catches stragglers that
// settled a moment later — a long second wait would tax every clean batch for
// the rare hung child.
const FINAL_STOP_SWEEP_MS = 1_000;
