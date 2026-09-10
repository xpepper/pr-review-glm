// I3 dogfood wiring: the dev-loop's own reviewer is the plugin itself.
// Dispatches /z-pr-review <PR> --no-comment through the same SDK harness the
// smoke scripts use (tests/smoke-harness.mjs — shared, not forked), asserts at
// dispatch that our commands are registered with OUR descriptions (the real
// protection against command-name ambiguity now that the prototype-absent
// preflight gate is gone), maps the plugin's machine summary into the loop's
// review-file contract, and writes it next to the independent review.
//
// Authority stays code-owned: the model only proposes findings inside the
// lane; severity mapping and the verdict are computed here.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MACHINE_BLOCK = /```z-pr-review-findings\n([\s\S]*?)```/;
const EXPECTED_DESCRIPTIONS = {
  "z-pr-review": "PR review via a heavy reviewer lane over the captured diff; status and help",
};

// Machine summary → loop review contract. Fail-closed: any incomplete lane,
// missing or malformed summary, or dropped-everything run blocks the merge.
export function dogfoodVerdict(summary, { source = "dispatch" } = {}) {
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) {
    return {
      verdict: "request-changes",
      findings: [{ severity: "P1", title: `dogfood review produced no machine summary (${source})` }],
    };
  }
  if (summary.status !== "complete") {
    return {
      verdict: "request-changes",
      findings: [{ severity: "P1", title: `dogfood review lane incomplete: ${String(summary.reason ?? "unknown")}` }],
    };
  }
  const findings = (Array.isArray(summary.findings) ? summary.findings : [])
    .filter((finding) => finding && typeof finding === "object" && typeof finding.title === "string")
    .map((finding) => ({
      // The loop contract carries P0–P2; P3/nit map to P2 (non-blocking either way).
      severity: finding.severity === "P0" || finding.severity === "P1" ? finding.severity : "P2",
      title: finding.title,
    }));
  const blocking = findings.some((finding) => finding.severity === "P0" || finding.severity === "P1");
  if (blocking) return { verdict: "request-changes", findings };
  if (findings.length > 0) return { verdict: "approve-with-nits", findings };
  return { verdict: "approve", findings: [] };
}

export function parseMachineSummary(messages) {
  for (const message of messages) {
    const match = MACHINE_BLOCK.exec(message);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        return { status: "malformed-json" };
      }
    }
  }
  return null;
}

// Contract of the other phase runners: { code, stdout, stderr, timedOut, review }.
export async function runDogfoodReview({ prNumber, repoRoot, timeoutMs, log = () => {} }) {
  const { startPluginSession, stopClient, waitForCommands } = await import("../../tests/smoke-harness.mjs");
  let client;
  const withTimeout = (promise) => Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), timeoutMs)),
  ]);
  try {
    const started = await startPluginSession({ repoRoot });
    client = started.client;
    // Dispatch-time registration assertion: a sibling plugin squatting on our
    // command names fails here, loudly, before anything is reviewed.
    await waitForCommands(started.session, EXPECTED_DESCRIPTIONS);
    const messages = await withTimeout(runPluginCommand(started.session, prNumber));
    if (messages.timedOut) {
      return { code: 1, stdout: "", stderr: `dogfood review timed out after ${timeoutMs}ms`, timedOut: true, review: undefined };
    }
    const summary = parseMachineSummary(messages);
    const review = dogfoodVerdict(summary);
    const reviewFile = join(repoRoot, ".dev-loop", "review-dogfood.json");
    mkdirSync(join(repoRoot, ".dev-loop"), { recursive: true });
    writeFileSync(reviewFile, `${JSON.stringify(review, null, 2)}\n`);
    log(`dogfood verdict=${review.verdict} findings=${review.findings.length} (${reviewFile})`);
    return { code: 0, stdout: messages.join("\n"), stderr: "", timedOut: false, review };
  } catch (error) {
    return { code: 1, stdout: "", stderr: String(error?.stack ?? error), timedOut: false, review: undefined };
  } finally {
    try {
      if (client) await stopClient(client);
    } catch (error) {
      log(`dogfood cleanup problem (client stop): ${String(error)}`);
    }
  }
}

async function runPluginCommand(session, prNumber) {
  const before = (await session.getEvents()).length;
  const result = await session.rpc.commands.execute({
    commandName: "z-pr-review",
    args: `${prNumber} --no-comment`,
  });
  if (result.error !== undefined) {
    throw new Error(`/z-pr-review ${prNumber} --no-comment failed: ${result.error}`);
  }
  // The lane's inference happens inside its own child runtime; the parent
  // session stream must still show nothing but command logging.
  const events = (await session.getEvents()).slice(before);
  const inference = events.filter((event) =>
    event.type === "user.message" ||
    event.type.startsWith("assistant.") ||
    event.type.startsWith("model.") ||
    event.type.startsWith("subagent.") ||
    event.type === "tool.execution_start" ||
    event.type === "session.usage_checkpoint"
  );
  if (inference.length > 0) {
    throw new Error(`dogfood dispatch leaked inference into the parent session: ${inference.map((e) => e.type).join(", ")}`);
  }
  return events
    .filter((event) => event.type === "session.info" || event.type === "session.error")
    .map((event) => event.data.message);
}
