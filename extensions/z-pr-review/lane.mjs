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

// One lane attempt at an explicit tier. The deadline is the caller's: the
// tier attempt cap (deadlines.attemptMs.<tier>) possibly intersected with the
// batch/total budgets by the caller (batch.mjs); exceeding it aborts the child
// session and classifies the attempt failed. modelOverride serves fallback
// attempts (tier.fallback); signal propagates parent cancellation into the
// child session. `createRuntime` is injectable so unit tests drive a fake
// child runtime; cliPath resolves lazily inside defaultCreateRuntime so
// injected runtimes never touch PATH.
export async function runLane({
  lane,
  envelope,
  config,
  repoRoot,
  cliPath,
  deadlineMs,
  modelOverride,
  signal = null,
  createRuntime = defaultCreateRuntime,
}) {
  const tier = config.tiers[lane.tier];
  const prompt = buildLanePrompt(envelope, lane);
  if (signal?.aborted) {
    return { status: "failed", reason: "cancelled before dispatch", findings: [], dropped: [], laneText: "", laneId: lane.id, tier: lane.tier };
  }
  const { client, session } = await createRuntime({
    cliPath,
    repoRoot,
    model: modelOverride ?? tier.model ?? undefined,
    reasoningEffort: tier.effort,
    availableTools: ["builtin:view", "builtin:grep", "builtin:glob"],
    enableConfigDiscovery: false,
    permission: lanePermissionPolicy(repoRoot),
  });
  const result = await driveLane(session, {
    prompt,
    deadlineMs,
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

async function driveLane(session, { prompt, deadlineMs, cleanup, signal = null }) {
  const outcome = { status: "failed", reason: "", findings: [], dropped: [], laneText: "" };
  const { promise, resolve, reject } = Promise.withResolvers();
  promise.catch(() => {});
  let timer = null;
  const onAbort = () => {
    outcome.reason = "cancelled";
    session.abort?.().catch(() => {});
    reject(new LaneError("cancelled"));
  };
  const finish = () => {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    cleanup?.().catch(() => {});
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  timer = setTimeout(() => {
    outcome.reason = `deadline exceeded after ${deadlineMs}ms`;
    session.abort?.().catch(() => {});
    reject(new LaneError(outcome.reason));
  }, deadlineMs);
  const unsubscribe = session.on((event) => {
    switch (event.type) {
      case "assistant.message":
        outcome.laneText = event.data.content ?? "";
        break;
      case "session.error":
        outcome.reason = event.data.message ?? "session error";
        reject(new LaneError(outcome.reason));
        break;
      case "session.shutdown":
        outcome.reason = "session shut down before completion";
        reject(new LaneError(outcome.reason));
        break;
      case "session.idle": {
        const unwrapped = unwrapLaneOutput(outcome.laneText);
        if (unwrapped.status === "malformed") {
          outcome.reason = `output contract violated: ${unwrapped.reason}`;
          reject(new LaneError(outcome.reason));
          break;
        }
        const parsed = parseFindings(unwrapped.payload);
        if (parsed.status === "malformed") {
          outcome.reason = `output contract violated: ${parsed.reason}`;
          reject(new LaneError(outcome.reason));
          break;
        }
        outcome.status = "complete";
        outcome.findings = parsed.findings;
        outcome.dropped = parsed.dropped;
        resolve(outcome);
        break;
      }
    }
  });
  try {
    await Promise.all([session.send({ prompt }), promise]);
    return outcome;
  } catch (error) {
    if (!(error instanceof LaneError)) {
      outcome.reason = String(error?.message ?? error);
    }
    return outcome;
  } finally {
    unsubscribe?.();
    finish();
  }
}
