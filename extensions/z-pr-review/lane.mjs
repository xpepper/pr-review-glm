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
import { buildFileBackedLanePrompt } from "./transport.mjs";

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

// A contract violation is only diagnosable if the offending output travels
// with the failure: the reason carries a whitespace-flattened excerpt of what
// the lane actually said (model text, rendered inert — never parsed, never
// authoritative).
function laneExcerpt(laneText) {
  // Bound the input BEFORE any processing (round-5 review P2): the lane
  // response is unbounded model text, and each pass below would otherwise copy
  // the whole thing twice just to keep 120 characters.
  const bounded = String(laneText ?? "").slice(0, 512);
  // Control characters (C0/C1, ANSI escapes) and Unicode bidirectional
  // controls (LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI, LRM/RLM/ALM) in model
  // output could spoof whatever terminal or log renders the failure reason —
  // strip them before the excerpt exists (round-2 + round-5 dogfood P2; same
  // neutralization instinct as renderReview's backtick flattening).
  const stripped = bounded.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ");
  const flattened = stripped.replace(/\s+/g, " ").trim();
  if (flattened.length === 0) return " — lane output was empty";
  return ` — lane output began: "${flattened.slice(0, 120)}"`;
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
    "Exact output shape (markers alone on their lines; with no findings, the same two",
    "marker lines with [] between them):",
    REVIEW_ENVELOPE_BEGIN,
    '[{"severity":"P2","title":"one sentence","file":"path/from/diff.mjs","line":12,"detail":"why, citing the diff"}]',
    REVIEW_ENVELOPE_END,
    "",
    "The diff:",
    "```diff",
    envelope.diff,
    "```",
  ].join("\n");
}

// Confinement is enforced here, not by the prompt: reads resolve to real paths
// inside the reviewed checkout (or, under I8 file-backed transport, inside the
// transport directory holding the captured diff's per-file sections) or are
// rejected; every other request is denied. Approved reads can be observed via
// onReadApproved — the file-backed transport's completeness check is built on
// exactly that signal (the permission event carries a path, not line ranges,
// so coverage is tracked per file).
export function lanePermissionPolicy(repoRoot, { extraRoots = [], onReadApproved = null } = {}) {
  const roots = [repoRoot, ...extraRoots].map((root) => realpathSync(root));
  const contains = (path) => {
    const absolute = isAbsolute(path) ? path : resolve(roots[0], path);
    let real;
    try {
      real = realpathSync(absolute);
    } catch {
      return { kind: "reject", message: `Lane reads must stay inside the reviewed checkout: ${path}` };
    }
    const inside = roots.some((root) => {
      const rel = relative(root, real);
      return !(rel.startsWith("..") || isAbsolute(rel));
    });
    if (!inside) {
      return { kind: "reject", message: `Lane reads must stay inside the reviewed checkout: ${path}` };
    }
    return { kind: "approve-once" };
  };
  return {
    onPermissionRequest: async (request) => {
      if (request.kind === "read" && typeof request.path === "string") {
        const decision = contains(request.path);
        if (decision.kind === "approve-once" && onReadApproved) onReadApproved(request.path);
        return decision;
      }
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
  // I5: the adjudicator reuses the whole lane machinery — budgets, envelope
  // contract, cancellation — with its own prompt over the diff plus candidates.
  prompt = null,
  // I8: a file-backed transport for large diffs. When present, the lane prompt
  // is the manifest form (no embedded diff) and the transport dir joins the
  // readable roots. For reviewer lanes (enforceReadCoverage, the default)
  // completeness is enforced from permission events: a session that reaches
  // idle without reading every required file is a FAILED lane, never a
  // complete review (spec: "completeness enforced from tool events" — file
  // granularity; read requests carry paths, not ranges). The adjudicator
  // passes the transport WITHOUT enforcement: merging candidates needs
  // targeted reads, and its output is re-validated host-side regardless.
  transport = null,
  enforceReadCoverage = true,
}) {
  const tier = config.tiers[lane.tier];
  // C1: a lane (custom role) may override the tier's model/effort; absent
  // overrides fall back to the tier's values, and a null model means the
  // session's model either way.
  const tierModel = lane.model !== undefined ? lane.model : tier.model;
  const tierEffort = lane.effort !== undefined ? lane.effort : tier.effort;
  const lanePrompt =
    prompt ??
    (transport !== null
      ? buildFileBackedLanePrompt(envelope, transport, lane)
      : buildLanePrompt(envelope, lane));
  if (signal?.aborted) {
    return { status: "failed", reason: "cancelled before dispatch", findings: [], dropped: [], laneText: "", laneId: lane.id, tier: lane.tier };
  }
  // Per-attempt read tracking for the completeness check. Each attempt gets a
  // fresh set (a fallback attempt re-reads; stale coverage from a failed
  // attempt must not validate the retry).
  const transportFilesByPath = new Map();
  let readTransportFiles = null;
  if (transport !== null && enforceReadCoverage) {
    readTransportFiles = new Set();
    for (const file of transport.files) {
      try {
        transportFilesByPath.set(realpathSync(file.absolutePath), file);
      } catch {
        // The transport file disappeared between build and dispatch: the
        // coverage check below reports it as permanently unread — fail-closed
        // without a spawn.
        return {
          status: "failed",
          reason: `file-backed transport is unreadable: ${file.absolutePath}`,
          findings: [],
          dropped: [],
          laneText: "",
          laneId: lane.id,
          tier: lane.tier,
        };
      }
    }
  } else if (transport !== null) {
    // No coverage enforcement (the adjudicator), but the transport must still
    // EXIST before dispatch (dogfood round-2 P2): a vanished section would
    // let an unenforced caller merge candidates against a file it could never
    // read — host re-validation anchors against the captured diff, which
    // still names that file, so nothing downstream would catch the gap.
    for (const file of transport.files) {
      try {
        realpathSync(file.absolutePath);
      } catch {
        return {
          status: "failed",
          reason: `file-backed transport is unreadable: ${file.absolutePath}`,
          findings: [],
          dropped: [],
          laneText: "",
          laneId: lane.id,
          tier: lane.tier,
        };
      }
    }
  }
  const coverage =
    readTransportFiles !== null
      ? {
          total: transport.files.length,
          missing: () => transport.files.filter((file) => !readTransportFiles.has(file.absolutePath)),
          record: (path) => {
            let real;
            try {
              real = realpathSync(path);
            } catch {
              return;
            }
            const file = transportFilesByPath.get(real);
            if (file !== undefined) readTransportFiles.add(file.absolutePath);
          },
        }
      : null;
  const creation = createRuntime({
    cliPath,
    repoRoot,
    // An explicit null override means "the session's default model" exactly as
    // a null tier model does — `??` would wrongly retry the tier's primary
    // model on a null fallback override.
    model: (modelOverride !== undefined ? modelOverride : tierModel) ?? undefined,
    reasoningEffort: tierEffort,
    availableTools: ["builtin:view", "builtin:grep", "builtin:glob"],
    enableConfigDiscovery: false,
    permission: lanePermissionPolicy(repoRoot, {
      extraRoots: transport !== null ? [transport.dir] : [],
      onReadApproved: coverage ? coverage.record : null,
    }),
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
    prompt: lanePrompt,
    deadlineAt,
    cleanup: () => client.stop(),
    signal,
    coverage,
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

// I8 telemetry: per-lane usage accumulated from the child session's runtime
// events — model.call_finished (dispatch count/duration/outcome) and
// session.usage_checkpoint (the session's accumulated nano-AI-units cost; the
// child session is fresh per attempt, so the last checkpoint minus the first
// is that attempt's own spend). Informational ONLY: nothing here can gate,
// fail, or re-order anything, and only finite non-negative numbers enter the
// outcome — unknown event shapes are skipped, never string-copied.
function emptyTelemetry() {
  return { calls: 0, success: 0, error: 0, cancelled: 0, rejected: 0, dispatchMs: 0 };
}

function noteCallFinished(outcome, data) {
  const telemetry = (outcome.telemetry ??= emptyTelemetry());
  telemetry.calls += 1;
  const kind = data?.outcome;
  if (kind === "success" || kind === "error" || kind === "cancelled" || kind === "rejected") {
    telemetry[kind] += 1;
  }
  const ms = Number(data?.dispatchDurationMs);
  if (Number.isFinite(ms) && ms >= 0) telemetry.dispatchMs += ms;
}

function noteUsageCheckpoint(outcome, data) {
  const total = Number(data?.totalNanoAiu);
  if (!Number.isFinite(total) || total < 0) return;
  const telemetry = (outcome.telemetry ??= emptyTelemetry());
  if (telemetry.firstNanoAiu === undefined) {
    // The checkpoint total is session-accumulated. If it arrives BEFORE any
    // dispatch it is a clean baseline; if dispatches already happened, the
    // total already includes this (fresh, per-attempt) session's own spend —
    // the baseline is 0, not that total, or the delta would silently drop
    // everything accrued before the first checkpoint (dogfood round-1 P2).
    telemetry.firstNanoAiu = telemetry.calls > 0 ? 0 : total;
  }
  telemetry.lastNanoAiu = total;
}

function finalizeTelemetry(outcome) {
  const telemetry = outcome.telemetry;
  if (telemetry === undefined) return;
  const first = telemetry.firstNanoAiu ?? 0;
  const last = telemetry.lastNanoAiu ?? 0;
  // Derived, ready to render: this attempt's own spend.
  telemetry.usageNanoAiu = Math.max(0, last - first);
}

async function driveLane(session, { prompt, deadlineAt, cleanup, signal = null, coverage = null }) {
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
    finalizeTelemetry(outcome);
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
      case "model.call_finished":
        // I8 telemetry: never settles the attempt, never gates anything.
        noteCallFinished(outcome, event.data);
        break;
      case "session.usage_checkpoint":
        noteUsageCheckpoint(outcome, event.data);
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
        // I8 completeness (spec: "completeness enforced from tool events"):
        // a lane that finished without reading every required transport file
        // did not review the surface it was given — its report is rejected
        // like any other contract violation (fail-closed, findings not
        // claimed; the fallback attempt re-reads from a fresh coverage set).
        if (coverage !== null) {
          const missing = coverage.missing();
          if (missing.length > 0) {
            outcome.reason = `file-backed transport incomplete: read ${coverage.total - missing.length} of ${coverage.total} required files (unread: ${missing
              .slice(0, 3)
              .map((file) => file.path)
              .join(", ")}${missing.length > 3 ? ", …" : ""})`;
            settle(() => reject(new LaneError(outcome.reason)));
            break;
          }
        }
        const unwrapped = unwrapLaneOutput(outcome.laneText);
        if (unwrapped.status === "malformed") {
          outcome.reason = `output contract violated: ${unwrapped.reason}${laneExcerpt(outcome.laneText)}`;
          settle(() => reject(new LaneError(outcome.reason)));
          break;
        }
        const parsed = parseFindings(unwrapped.payload);
        if (parsed.status === "malformed") {
          outcome.reason = `output contract violated: ${parsed.reason}${laneExcerpt(outcome.laneText)}`;
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
