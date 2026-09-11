// I3+ smoke script: the real review, dispatched by RPC against an open PR of
// this repository — /z-pr-review N --no-comment captures the PR, then (I4)
// runs the default mode's concurrent tiered lane batch — owned Copilot SDK
// child runtimes — and renders findings in-chat. Unlike smoke-i1/i2 this
// smoke DOES perform inference, by design: the model runs inside the lanes'
// child runtimes (the point of I3).
// The parent session stream must still show zero inference (harness
// assertion in runCommand) — the review is dispatched, never prompted.
//
// Usage:
//   node tests/smoke-i3.mjs
// Env: SMOKE_PR_NUMBER (default: this repo's single open PR; with no open PR
//      the scenario is SKIPPED — capture needs a live PR, and preflight on
//      idle main must not fail the gate),
//      COPILOT_CLI_PATH / COPILOT_SDK_PATH (see smoke-harness.mjs).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runCommand, startPluginSession, stopClient, waitForCommands } from "./smoke-harness.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function resolvePrNumber() {
  if (process.env.SMOKE_PR_NUMBER) return Number(process.env.SMOKE_PR_NUMBER);
  const open = JSON.parse(
    execFileSync("gh", ["pr", "list", "--state", "open", "--json", "number"], { cwd: repoRoot, encoding: "utf8" }) || "[]",
  );
  if (open.length === 0) return null;
  assert.equal(open.length, 1, `expected at most one open PR for the default scenario, found: ${open.map((p) => p.number).join(", ")}`);
  return open[0].number;
}

const prNumber = resolvePrNumber();
let client;
let cleanedUp = false;
let capturePath = null;

process.once("SIGINT", () => void exitViaSignal("SIGINT"));
process.once("SIGTERM", () => void exitViaSignal("SIGTERM"));

async function exitViaSignal(signal) {
  console.error(`\n${signal} received — cleaning up before exit.`);
  cleanupSync();
  await safeStop();
  process.exit(130);
}

function cleanupSync() {
  if (cleanedUp || capturePath === null) return;
  rmSync(capturePath, { force: true });
  const dir = join(capturePath, "..");
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  } catch {
    // directory already gone — nothing to clean
  }
}

async function safeStop() {
  try {
    if (client) await stopClient(client);
  } catch (error) {
    console.error(`CLEANUP PROBLEM: client stop: ${String(error)}`);
    process.exitCode = 1;
  }
}

try {
  const started = await startPluginSession({ repoRoot });
  client = started.client;
  const session = started.session;

  await waitForCommands(session, {
    "z-pr-review": "PR review via concurrent tiered reviewer lanes over the captured diff; status and help",
  });
  console.log("PASS /z-pr-review is registered by the plugin extension");

  if (prNumber === null) {
    console.log("SKIP I3 scenario: no open PR to review (preflight runs on idle main). Set SMOKE_PR_NUMBER to force one.");
    console.log("SMOKE PASS I3: command registration verified, scenario skipped");
  } else {
    const messages = await runCommand(session, "z-pr-review", `${prNumber} --no-comment`);
    const report = messages.find((message) => message.includes(`Reviewed PR #${prNumber}`));
    assert.ok(report, `the review report must be rendered in-chat, got: ${messages.join(" | ")}`);
    assert.match(report, /^Mode: balanced — 5 lane/m);
    const machine = /```z-pr-review-findings\n([\s\S]*?)```/.exec(report);
    assert.ok(machine, "the report must carry the machine summary block");
    const summary = JSON.parse(machine[1]);
    assert.equal(summary.mode, "balanced", "the default mode is balanced");
    assert.equal(summary.lanes.length, 5, "balanced topology is 5 lanes");
    assert.equal(
      summary.status,
      "complete",
      `every lane must satisfy the output contract (status ${summary.status}): ${summary.reason ?? ""}`,
    );
    assert.ok(Array.isArray(summary.findings), "findings must be an array");
    const completeLanes = summary.lanes.filter((lane) => lane.status === "complete").length;
    console.log(`PASS tiered lane batch reviewed PR #${prNumber}: ${completeLanes}/5 lanes complete, ${summary.findings.length} finding(s), ${summary.dropped} dropped`);
    const captureLine = report.match(/Capture file: (\S+) \(0600\)/) ?? messages.join(" | ").match(/Capture file: (\S+) \(0600\)/);
    if (captureLine) capturePath = captureLine[1];

    console.log(`SMOKE PASS I3: PR #${prNumber} reviewed by the tiered lane batch, findings in-chat, parent session inference-free`);
  }
} finally {
  cleanupSync();
  cleanedUp = true;
  await safeStop();
}
