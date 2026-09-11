// I4: the lane batch — runs a mode's topology concurrently under the config
// budgets. Every decision here is code-owned: attempt plans (tier model, then
// one configured fallback), deadline math (tier attempt cap intersected with
// the batch window and the total hard cap), and lifecycle classification.
// Model text never influences any of it (spec: "Degradation and budgets").
import { runLane } from "./lane.mjs";

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
      attempts.push({ model: attempt.model, label: attempt.label, status: "failed", reason: "budget expired before dispatch" });
      break;
    }
    const outcome = await runLane({
      lane,
      envelope,
      config,
      repoRoot,
      cliPath,
      deadlineMs: Math.min(attempt.capMs, remaining),
      modelOverride: attempt.model,
      signal,
      createRuntime,
    });
    attempts.push({
      model: attempt.model,
      label: attempt.label,
      status: outcome.status,
      reason: outcome.status === "complete" ? undefined : outcome.reason,
    });
    if (outcome.status === "complete") return { ...outcome, attempts };
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
  return { status: "partial", reason: `${failed.length} of ${laneResults.length} lane(s) failed: ${incomplete}` };
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
      await onLaneDone?.(lane, result);
      return result;
    }),
  );
  return {
    mode,
    lanes: laneResults,
    elapsedMs: Date.now() - startedAt,
    ...batchStatus(laneResults),
  };
}
