// I4: the lane batch — runs a mode's topology concurrently under the config
// budgets. Every decision here is code-owned: attempt plans (tier model, then
// one configured fallback), deadline math (tier attempt cap intersected with
// the batch window and the total hard cap), and lifecycle classification.
// Model text never influences any of it (spec: "Degradation and budgets").
import { drainUnconfirmedStops, runLane } from "./lane.mjs";

// One lane's attempt plan: the tier's model under the tier's attempt cap,
// then one retry under fallbackMs — on the tier's fallback model when
// configured, otherwise on the tier's own model. Without the same-model
// retry, the coarse "every failure retries once" rule was a no-op on default
// configs (no fallback configured), so a single model flake — e.g. an
// output-contract violation (PR #23 dogfood: performance-resources emitted no
// whole-line begin marker) — failed the lane and degraded the whole review to
// partial. Upstream classifies retryability finely (rate limits, quota,
// overload); our child events do not carry that yet, so the retry stays
// coarse and the attempt record discloses what ran. Richer classification
// arrives with telemetry (I8).
function attemptPlan(lane, config) {
  const tier = config.tiers[lane.tier];
  // C1: a lane (custom role) model override replaces the tier model as the
  // primary and as the same-model retry; the tier's configured fallback model
  // still wins when present (it is the explicit escape hatch for a flaky
  // primary).
  const laneModel = (lane.model !== undefined ? lane.model : tier.model) ?? null;
  const plan = [{ model: laneModel, capMs: config.deadlines.attemptMs[lane.tier], label: "primary" }];
  if (tier.fallback !== undefined) {
    plan.push({ model: tier.fallback, capMs: config.deadlines.fallbackMs, label: "fallback" });
  } else {
    plan.push({ model: laneModel, capMs: config.deadlines.fallbackMs, label: "retry" });
  }
  return plan;
}

// I8: the lane-level telemetry REPORTED for a lane is the sum over its
// attempts (dogfood round-3 P2: a failed primary that spent 5 AIU followed by
// a successful fallback that spent 3 reported only 3). Attempt records keep
// their own telemetry untouched.
function mergeAttemptTelemetry(attempts) {
  let merged = null;
  for (const attempt of attempts) {
    const t = attempt.telemetry;
    if (t === undefined || t === null) continue;
    if (merged === null) {
      merged = { ...t };
      continue;
    }
    for (const key of ["calls", "success", "error", "cancelled", "rejected", "dispatchMs", "usageNanoAiu"]) {
      if (Number.isFinite(t[key])) merged[key] = (merged[key] ?? 0) + t[key];
    }
  }
  return merged;
}

// I8 (dogfood round 4, live on this very PR — the first real ≥200 KB review):
// file-backed lanes spend minutes on required file reads before any finding
// can exist, and the inline-tuned caps (fallback 180s especially) starved
// them — a 26-of-27-files lane died re-reading on a fallback budget. The
// allowance is proportional to the manifest (10s per required file, capped
// at +3m) and applies ONLY when a transport is in play: inline reviews keep
// the exact deadline semantics they have always had.
export function transportReadAllowanceMs(transport) {
  if (transport === null || transport === undefined || transport.mode !== "file-backed") return 0;
  return Math.min(transport.fileCount * 10_000, 180_000);
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
  transport = null,
}) {
  const hardEndAt = Math.min(batchEndAt, totalEndAt);
  const allowanceMs = transportReadAllowanceMs(transport);
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
      deadlineAt: Math.min(Date.now() + attempt.capMs + allowanceMs, hardEndAt),
      modelOverride: attempt.model,
      signal,
      createRuntime,
      transport,
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
      // I8: per-attempt runtime telemetry, when the child session produced
      // usage events (informational only — never an input to any decision).
      ...(outcome.telemetry ? { telemetry: outcome.telemetry } : {}),
    });
    if (outcome.status === "complete") {
      const telemetry = mergeAttemptTelemetry(attempts);
      return { ...outcome, ...(telemetry ? { telemetry } : {}), attempts };
    }
    if (reason !== outcome.reason) {
      const telemetry = mergeAttemptTelemetry(attempts);
      return { ...outcome, reason, findings: [], dropped: [], ...(telemetry ? { telemetry } : {}), attempts };
    }
  }
  const last = attempts.at(-1);
  const merged = mergeAttemptTelemetry(attempts);
  return {
    status: "failed",
    reason: last?.reason ?? "no attempt dispatched",
    findings: [],
    dropped: [],
    laneText: "",
    laneId: lane.id,
    tier: lane.tier,
    attempts,
    ...(merged ? { telemetry: merged } : {}),
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
// attempt deadline. `reviewDeadlineAt` (V2), when set, is the REVIEW-level
// hard end the caller computed from the review's own start (review start +
// totalMs + any transport allowance): the batch never outlives it, so time
// spent before dispatch — file-backed transport construction — can never
// widen the batch's total window past the deadline the adjudication clip and
// the caller's own accounting use (a V2 ground-test finding: the restarted
// clock let lanes run after the review-level window had closed).
// `signal` cancels every not-yet-finished lane; progress is
// reported per lane through onLaneDone as each lane settles. `transport` (I8), when
// non-null, switches every lane to the file-backed large-diff transport.
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
  transport = null,
  reviewDeadlineAt = null,
}) {
  if (lanes.length === 0) {
    throw new Error(`review mode "${mode}" has an empty topology`);
  }
  const startedAt = Date.now();
  // File-backed batches widen their windows by the same per-file allowance the
  // attempts get (dogfood round 4): without it, the batch window (12m) — not
  // the attempt caps — becomes the binding constraint that kills slow-reading
  // lanes mid-manifest. Inline reviews are exactly as before. The review-level
  // deadline caps the widened window (V2): Math.min, never an extension.
  const allowanceMs = transportReadAllowanceMs(transport);
  const batchEndAt = Math.min(
    startedAt + config.deadlines.batchMs + allowanceMs,
    reviewDeadlineAt ?? Number.MAX_SAFE_INTEGER,
  );
  const totalEndAt = Math.min(
    startedAt + config.deadlines.totalMs + allowanceMs,
    reviewDeadlineAt ?? Number.MAX_SAFE_INTEGER,
  );
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
        transport,
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
