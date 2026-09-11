// I3–I4: reviewer lanes — Copilot SDK child runtimes over the captured diff,
// envelope-marker output contract (structured output is broken on Copilot CLI
// 1.0.83), findings parsed deterministically by this code. I4 generalizes the
// single heavy lane to any tier: the lane descriptor picks the tier (model +
// effort from config), a model override serves fallback attempts, the attempt
// deadline comes from the caller (tier cap intersected with batch/total
// budgets in batch.mjs), and an AbortSignal propagates parent cancellation
// into the child session. The session LLM never touches this path (spec:
// "Architecture A", "Publication gates" authority rule).

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export const REVIEW_ENVELOPE_BEGIN = "<<<REVIEW_BEGIN>>>";
export const REVIEW_ENVELOPE_END = "<<<REVIEW_END>>>";
export const SEVERITIES = ["P0", "P1", "P2", "P3", "nit"];

export class LaneError extends Error {
  constructor(reason) {
    super(`Review lane failed: ${reason}`);
    this.reason = reason;
  }
}

// The output contract: markers count only as whole lines, and exactly one
// whole-response fence around the payload is unwrapped. Anything else is
// malformed — including marker-looking text that only appears mid-line.
// Tolerating prose before/after the markers is deliberate: the spec's
// contract is about locating the payload (whole-line markers, one fence), not
// about rejecting a chatty model; the parsed findings themselves get shape
// validation here and full anchor/evidence validation in I5.
export function unwrapLaneOutput(text) {
  const lines = String(text).split(/\r?\n/);
  const isMarker = (line, marker) => line.trim() === marker;
  const begin = lines.findIndex((line) => isMarker(line, REVIEW_ENVELOPE_BEGIN));
  if (begin === -1) return { status: "malformed", reason: "no begin marker as a whole line" };
  const end = lines.findIndex((line, index) => index > begin && isMarker(line, REVIEW_ENVELOPE_END));
  if (end === -1) return { status: "malformed", reason: "no end marker after the begin marker" };
  let payload = lines.slice(begin + 1, end).join("\n").trim();
  const fence = /^```[^\s`]*\r?\n([\s\S]*)\r?\n```$/.exec(payload);
  if (fence) payload = fence[1].trim();
  if (payload.length === 0) return { status: "malformed", reason: "empty envelope payload" };
  return { status: "ok", payload };
}

// Deterministic candidate shaping (full validation/adjudication is I5): each
// finding must carry a ladder severity and a non-empty title. Anything else is
// dropped and disclosed — never silently kept, never promoted.
export function parseFindings(payload) {
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    return { status: "malformed", reason: `payload is not JSON: ${String(error.message)}` };
  }
  if (!Array.isArray(parsed)) {
    return { status: "malformed", reason: "payload is not a JSON array of findings" };
  }
  const findings = [];
  const dropped = [];
  parsed.forEach((candidate, index) => {
    const problem = findingProblem(candidate);
    if (problem === null) findings.push(candidate);
    else dropped.push({ index, reason: problem });
  });
  return { status: "ok", findings, dropped };
}

function findingProblem(candidate) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return "not an object";
  }
  if (!SEVERITIES.includes(candidate.severity)) {
    return `severity "${String(candidate.severity)}" is not on the ladder`;
  }
  if (typeof candidate.title !== "string" || candidate.title.trim().length === 0) {
    return "missing or empty title";
  }
  if (candidate.file !== undefined && typeof candidate.file !== "string") return "file is not a string";
  if (candidate.line !== undefined && !(Number.isInteger(candidate.line) && candidate.line >= 1)) {
    return "line is not a positive integer";
  }
  if (candidate.detail !== undefined && typeof candidate.detail !== "string") {
    return "detail is not a string";
  }
  return null;
}

// The lane prompt carries the lane's fixed id and objective (topologies.mjs);
// other lanes cover the rest of the diff, so a lane reports only its own
// focus. The objective is model input, never authority — findings are shaped
// and (from I5) validated by host code.
export function buildLanePrompt(envelope, lane = null) {
  const focus = lane === null ? [] : [
    `You are the "${lane.id}" lane (${lane.tier} tier).`,
    `Your focus: ${lane.objective}.`,
    "Report only findings inside your focus; other lanes cover the rest of the review.",
    "",
  ];
  return [
    "You are one reviewer lane of a code-review tool. Review the following pull request diff.",
    `Repository: ${envelope.repo} — PR #${envelope.pr.number} "${envelope.pr.title}"`,
    `Base ${envelope.pr.base.refName} -> Head ${envelope.pr.head.refName}`,
    "",
    ...focus,
    "Report only defects you can ground in the diff: correctness bugs, contract violations,",
    "security, performance, or resource problems. Skip style nits you cannot justify.",
    "For each finding give a JSON object with fields: severity (P0|P1|P2|P3|nit), title",
    "(one sentence), file (path from the diff), line (line number in the new file), detail",
    "(why it is a problem, citing the diff).",
    "",
    "Output contract — follow it exactly:",
    `1. Your ENTIRE response is ${REVIEW_ENVELOPE_BEGIN} on its own line, then the findings`,
    `   as one JSON array, then ${REVIEW_ENVELOPE_END} on its own line.`,
    "2. Nothing else before, between, or after those two marker lines.",
    "3. If you find nothing, the array is empty: [].",
    "",
    "The diff:",
    "```diff",
    envelope.diff,
    "```",
  ].join("\n");
}

// Confinement is enforced here, not by the prompt: reads resolve to real paths
// inside the reviewed checkout or are rejected; every other request is denied.
export function lanePermissionPolicy(repoRoot) {
  const root = realpathSync(repoRoot);
  const contains = (path) => {
    const absolute = isAbsolute(path) ? path : resolve(root, path);
    let real;
    try {
      real = realpathSync(absolute);
    } catch {
      return { kind: "reject", message: `Lane reads must stay inside the reviewed checkout: ${path}` };
    }
    const rel = relative(root, real);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return { kind: "reject", message: `Lane reads must stay inside the reviewed checkout: ${path}` };
    }
    return { kind: "approve-once" };
  };
  return {
    onPermissionRequest: async (request) => {
      if (request.kind === "read" && typeof request.path === "string") return contains(request.path);
      return { kind: "reject", message: "Reviewer lanes are read-only." };
    },
  };
}

export function resolveLaneCliPath(env = process.env) {
  if (env.COPILOT_CLI_PATH) return env.COPILOT_CLI_PATH;
  return execFileSync("sh", ["-c", "command -v copilot"], { encoding: "utf8" }).trim();
}

// One lane attempt at an explicit tier, bounded by an ABSOLUTE deadline
// (deadlineAt, epoch ms): runtime creation, the driven attempt, and cleanup
// all live inside it, so a stalled spawn cannot outrun the batch/total
// budgets by starting its timer late. The caller (batch.mjs) computes it as
// the tier attempt cap intersected with the batch/total budgets. modelOverride
// serves fallback attempts (tier.fallback); signal propagates parent
// cancellation into the child session. `createRuntime` is injectable so unit
// tests drive a fake child runtime; cliPath resolves lazily inside
// defaultCreateRuntime so injected runtimes never touch PATH.
export async function runLane({
  lane,
  envelope,
  config,
  repoRoot,
  cliPath,
  deadlineAt,
  modelOverride,
  signal = null,
  createRuntime = defaultCreateRuntime,
}) {
  const tier = config.tiers[lane.tier];
  const prompt = buildLanePrompt(envelope, lane);
  if (signal?.aborted) {
    return { status: "failed", reason: "cancelled before dispatch", findings: [], dropped: [], laneText: "", laneId: lane.id, tier: lane.tier };
  }
  const creation = createRuntime({
    cliPath,
    repoRoot,
    // An explicit null override means "the session's default model" exactly as
    // a null tier model does — `??` would wrongly retry the tier's primary
    // model on a null fallback override.
    model: (modelOverride !== undefined ? modelOverride : tier.model) ?? undefined,
    reasoningEffort: tier.effort,
    availableTools: ["builtin:view", "builtin:grep", "builtin:glob"],
    enableConfigDiscovery: false,
    permission: lanePermissionPolicy(repoRoot),
  });
  // A child runtime that never finishes spawning must not eat past the
  // attempt budget uncounted; parent cancellation must not wait out the
  // creation window either. The creation race fires one cleanup grace BEFORE
  // deadlineAt, so a creation that loses the deadline race still has until
  // deadlineAt to settle and be stopped inside the budget. And a runtime that
  // finishes spawning AFTER the race below was lost (deadline or cancellation)
  // must not survive as a second live child next to whatever attempt follows —
  // it is stopped the moment it resolves. `abandoned` flips only when the race
  // is lost, so a creation that wins is never stopped here.
  let abandoned = false;
  let lateStop = null;
  creation.then(
    ({ client: lateClient }) => {
      if (abandoned) lateStop = stopBounded(() => lateClient.stop(), deadlineAt);
    },
    () => {},
  );
  let creationTimer;
  const detachCreationAbort = [];
  const racedCreation = Promise.race([
    creation,
    new Promise((_, reject) => {
      creationTimer = setTimeout(
        () => reject(new Error("runtime creation exceeded the attempt budget")),
        Math.max(1, deadlineAt - Date.now() - CLEANUP_GRACE_MS),
      );
    }),
    ...(signal
      ? [
          new Promise((_, reject) => {
            const onCreationAbort = () => reject(new LaneError("cancelled during runtime creation"));
            signal.addEventListener("abort", onCreationAbort, { once: true });
            detachCreationAbort.push(() => signal.removeEventListener("abort", onCreationAbort));
          }),
        ]
      : []),
  ]);
  let client;
  let session;
  try {
    ({ client, session } = await racedCreation);
  } catch (error) {
    abandoned = true;
    if (error instanceof LaneError) {
      // Cancellation: no fallback follows (the batch's loop breaks on the
      // aborted signal), but the lane must not return while a late creation may
      // still spawn a live child — the same bounded wait as the deadline path,
      // so cleanup lands inside the attempt budget (the total cap genuinely
      // includes cleanup, cancelled or not).
      const late = await Promise.race([
        creation.then(
          () => lateStop ?? "settled",
          () => "settled",
        ),
        new Promise((resolve) => setTimeout(() => resolve("timed-out"), Math.max(1, deadlineAt - Date.now()))),
      ]);
      const reason = late === "settled" ? error.reason : `${error.reason} (late child cleanup ${late})`;
      return { status: "failed", reason, cleanup: late === "settled" ? undefined : late, findings: [], dropped: [], laneText: "", laneId: lane.id, tier: lane.tier };
    }
    // Deadline lost: the creation may still resolve into a live child. Wait
    // (bounded by deadlineAt — the grace the race reserved above) for it to
    // settle and be stopped, so a fallback attempt never starts beside a
    // possibly-live child (one live runtime per lane). `lateStop` is assigned
    // by the handler registered before this await, synchronously when the
    // creation resolves.
    const late = await Promise.race([
      creation.then(
        () => lateStop ?? Promise.resolve("settled"),
        () => "settled",
      ),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), Math.max(1, deadlineAt - Date.now()))),
    ]);
    if (late !== "settled") {
      // The child could not be confirmed stopped: carry a cleanup status the
      // batch reads to skip the fallback (same rule as a failed post-drive
      // cleanup) and disclose why.
      const failure = new Error(`runtime creation exceeded the attempt budget; late child cleanup ${late}, fallback skipped`);
      failure.cleanup = late;
      throw failure;
    }
    throw error;
  } finally {
    clearTimeout(creationTimer);
    for (const detach of detachCreationAbort) detach();
  }
  // An abort that arrived while the runtime was being created must not be
  // swallowed: the freshly created child is stopped (bounded — never past
  // deadlineAt) before it is ever sent a prompt (adding a listener to an
  // already-aborted signal replays nothing).
  if (signal?.aborted) {
    const cleanup = await stopBounded(() => client.stop(), deadlineAt);
    const reason = cleanup === "settled"
      ? "cancelled during runtime creation"
      : `cancelled during runtime creation (child cleanup ${cleanup})`;
    return { status: "failed", reason, cleanup, findings: [], dropped: [], laneText: "", laneId: lane.id, tier: lane.tier };
  }
  const result = await driveLane(session, {
    prompt,
    deadlineAt,
    cleanup: () => client.stop(),
    signal,
  });
  return { ...result, laneId: lane.id, tier: lane.tier };
}

async function defaultCreateRuntime({ cliPath, repoRoot, model, reasoningEffort, availableTools, permission }) {
  const { CopilotClient, RuntimeConnection } = await import("@github/copilot-sdk");
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: cliPath ?? resolveLaneCliPath() }),
  });
  const session = await client.createSession({
    model,
    reasoningEffort,
    availableTools,
    workingDirectory: repoRoot,
    ...permission,
  });
  return { client, session };
}

// Cleanup gets a bounded grace window (upstream's termination grace). The
// attempt's drive deadline reserves that grace up front and the grace itself
// is clipped to the time left at cleanup, so the whole attempt — creation,
// drive, cleanup included — ends by deadlineAt and the batch/total budgets can
// never be blown by a fixed stop grace. A stop that hangs or fails must be
// visible to the caller so a fallback attempt is not started over a
// possibly-live prior child (one live runtime per lane).
const CLEANUP_GRACE_MS = 5_000;

// A stop that outlives its bounded grace keeps running best-effort — but it is
// never forgotten: it stays registered here until it settles, so the batch can
// sweep what remains at its end and a process shutdown can drain stragglers
// before exiting. Without this, a hung child runtime would outlive its lane
// with nothing left referencing it (untracked and alive indefinitely).
const unconfirmedStops = new Set();

export function pendingUnconfirmedStops() {
  return unconfirmedStops.size;
}

// Waits (never past `until`, epoch ms) for registered stops to settle. Returns
// the count still unconfirmed — a hung stop is disclosed, never hidden.
export async function drainUnconfirmedStops(until = Date.now() + CLEANUP_GRACE_MS) {
  while (unconfirmedStops.size > 0) {
    const remaining = until - Date.now();
    if (remaining <= 0) break;
    await Promise.race([
      Promise.allSettled([...unconfirmedStops]),
      new Promise((resolve) => setTimeout(resolve, remaining)),
    ]);
  }
  return unconfirmedStops.size;
}

// Runs a child stop and reports how it went, never waiting past `until`
// (epoch ms). The stop itself keeps running best-effort if it outlives the
// window, but no caller ever blocks on it past the attempt budget.
async function stopBounded(stop, until) {
  const graceMs = Math.max(1, Math.min(CLEANUP_GRACE_MS, until - Date.now()));
  let call;
  try {
    call = Promise.resolve(stop());
  } catch {
    // A stop() that throws synchronously still means the child may be live:
    // surface it as a failed cleanup, never as an exception escaping the
    // lifecycle bookkeeping (a fallback would then start beside the child).
    return "failed";
  }
  return new Promise((settled) => {
    let done = false;
    const forget = () => unconfirmedStops.delete(call);
    call.then(forget, forget);
    const grace = setTimeout(() => {
      if (done) return;
      done = true;
      unconfirmedStops.add(call);
      settled("timed-out");
    }, graceMs);
    call.then(
      () => {
        if (done) return;
        done = true;
        clearTimeout(grace);
        settled("settled");
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(grace);
        settled("failed");
      },
    );
  });
}

async function driveLane(session, { prompt, deadlineAt, cleanup, signal = null }) {
  const outcome = { status: "failed", reason: "", findings: [], dropped: [], laneText: "", cleanup: "none" };
  const { promise, resolve, reject } = Promise.withResolvers();
  promise.catch(() => {});
  // A session.send that never settles (e.g. it hangs after the child already
  // emitted session.idle) must not hold the attempt open past its deadline:
  // once the outcome settles, send is no longer awaited. A send rejection
  // before that still fails the attempt.
  let outcomeSettled = false;
  const settle = (settleWith) => {
    outcomeSettled = true;
    settleWith();
  };
  let timer = null;
  const onAbort = () => {
    // An abort arriving after the outcome settled (a lane that reached
    // session.idle and completed) must not relabel it: the review finished,
    // and cancellation elsewhere does not void a cleanly finished lane.
    if (!outcomeSettled) {
      outcome.reason = "cancelled";
      settle(() => reject(new LaneError("cancelled")));
    }
    session.abort?.().catch(() => {});
  };
  // Cleanup is awaited (within its grace) before the attempt settles so a
  // fallback attempt never starts while the prior child runtime is still
  // stopping — one live runtime per lane at any time, and the total budget
  // genuinely includes cleanup (spec: "Degradation and budgets").
  const finish = async () => {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (!cleanup) return;
    // The stop grace is clipped to the attempt's remaining budget: cleanup may
    // be started (the stop still runs, best-effort) but is never awaited past
    // deadlineAt.
    outcome.cleanup = await stopBounded(cleanup, deadlineAt);
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  // Reserve the cleanup grace inside the attempt window so the drive deadline
  // firing still leaves room to stop the child by deadlineAt.
  const deadlineMs = Math.max(1, deadlineAt - Date.now() - CLEANUP_GRACE_MS);
  timer = setTimeout(() => {
    if (outcomeSettled) return;
    outcome.reason = `deadline exceeded after ${deadlineMs}ms`;
    session.abort?.().catch(() => {});
    settle(() => reject(new LaneError(outcome.reason)));
  }, deadlineMs);
  const unsubscribe = session.on((event) => {
    // A terminal event (error, shutdown, deadline) settles the attempt; events
    // delivered after that — a session.idle the SDK emits after a fatal
    // session.error — must not mutate the outcome back into a "complete" lane.
    // The unsubscribe in the finally below races with already-queued events, so
    // the guard lives here, not only in the settle paths.
    if (outcomeSettled) return;
    switch (event.type) {
      case "assistant.message":
        outcome.laneText = event.data.content ?? "";
        break;
      case "session.error":
        outcome.reason = event.data.message ?? "session error";
        settle(() => reject(new LaneError(outcome.reason)));
        break;
      case "session.shutdown":
        outcome.reason = "session shut down before completion";
        settle(() => reject(new LaneError(outcome.reason)));
        break;
      case "session.idle": {
        const unwrapped = unwrapLaneOutput(outcome.laneText);
        if (unwrapped.status === "malformed") {
          outcome.reason = `output contract violated: ${unwrapped.reason}`;
          settle(() => reject(new LaneError(outcome.reason)));
          break;
        }
        const parsed = parseFindings(unwrapped.payload);
        if (parsed.status === "malformed") {
          outcome.reason = `output contract violated: ${parsed.reason}`;
          settle(() => reject(new LaneError(outcome.reason)));
          break;
        }
        outcome.status = "complete";
        outcome.findings = parsed.findings;
        outcome.dropped = parsed.dropped;
        settle(() => resolve(outcome));
        break;
      }
    }
  });
  try {
    const sendPromise = session.send({ prompt });
    const sendGuard = sendPromise.catch((error) => {
      if (outcomeSettled) return;
      // A send rejection is terminal for the attempt: flipping the guard here
      // keeps an already-queued session.idle from relabeling the failed send
      // as a completed lane after the await below has already moved on.
      outcomeSettled = true;
      throw error;
    });
    // sendGuard's rejection is consumed by the await below; keep an
    // observation on sendPromise itself so a post-settlement rejection never
    // surfaces as an unhandled rejection.
    sendPromise.catch(() => {});
    // Resolves only when the outcome settles; a send rejection before that
    // fails the attempt early. A send that merely succeeds (or hangs) never
    // ends the attempt — only the outcome or the deadline does.
    await new Promise((resolveAttempt, rejectAttempt) => {
      promise.then(resolveAttempt, rejectAttempt);
      sendGuard.catch((error) => rejectAttempt(error));
    });
    return outcome;
  } catch (error) {
    // A session.send rejection arriving after the outcome already settled as
    // complete (session.idle resolved first) must not overwrite the reason of
    // a complete review with an error.
    if (!(error instanceof LaneError) && outcome.status !== "complete") {
      outcome.reason = String(error?.message ?? error);
    }
    return outcome;
  } finally {
    unsubscribe?.();
    await finish();
  }
}
