// V2 ground-test driver (NOT a gate): runs ONE real /z-pr-review review
// through the MARKETPLACE-INSTALLED plugin copy — no --plugin-dir, so config
// discovery loads exactly what a user of the released version runs (there is
// never a second registration beside it). Unlike smoke-i3 this targets MERGED
// PRs (--include-closed --no-comment): ground testing reviews this repo's
// landed increments, and publication never happens.
//
// The parent-session inference-free assertion (harness runCommand) still
// applies — the review is dispatched, never prompted, and inference happens
// only inside the lanes' child runtimes (the I3 contract).
//
// Usage:
//   node tests/groundtest-v2.mjs <PR number> [--quick|--balanced|--full|--deep]
// Mode flag omitted = the config default (balanced on defaults; the real-user
// fresh-install posture V2 observes).
//
// Output: everything the command rendered, verbatim, then a parsed machine
// summary and wall-clock duration. Exit 0 whenever the review RENDERS — a
// partial/failed/degraded batch is a ground-test FINDING to read off the
// output, not a script failure.

import assert from "node:assert/strict";
import { readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runCommand, startPluginSession, stopClient, waitForCommands } from "./smoke-harness.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const MODE_FLAGS = new Set(["--quick", "--balanced", "--full", "--deep"]);
const [prArg, ...rest] = process.argv.slice(2);
const prNumber = Number(prArg);
assert.ok(
  Number.isInteger(prNumber) && prNumber > 0,
  `usage: node tests/groundtest-v2.mjs <PR number> [--quick|--balanced|--full|--deep]`,
);
const extraFlags = rest.filter((flag) => MODE_FLAGS.has(flag));
assert.deepEqual(
  rest.filter((flag) => !MODE_FLAGS.has(flag)),
  [],
  `unrecognized arguments: ${rest.join(" ")}`,
);
const modeFlag = extraFlags.length > 0 ? ` ${extraFlags[extraFlags.length - 1]}` : "";

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

const startedAt = Date.now();
try {
  const started = await startPluginSession({ repoRoot, pluginDir: null });
  client = started.client;
  const session = started.session;

  await waitForCommands(session, {
    "z-pr-review": "PR review via concurrent tiered reviewer lanes over the captured diff; status and help",
  });
  console.log(`PASS /z-pr-review is registered by the INSTALLED marketplace copy`);

  const args = `${prNumber} --include-closed --no-comment${modeFlag}`;
  console.log(`\n=== GROUND TEST: /z-pr-review ${args} (installed copy, dispatch by RPC) ===\n`);
  const messages = await runCommand(session, "z-pr-review", args);

  for (const message of messages) console.log(message);

  const report = messages.find((message) => message.includes(`Reviewed PR #${prNumber}`));
  assert.ok(report, `the review report must be rendered in-chat, got: ${messages.join(" | ")}`);
  const machine = /```z-pr-review-findings\n([\s\S]*?)```/.exec(report);
  assert.ok(machine, "the report must carry the machine summary block");
  const summary = JSON.parse(machine[1]);
  console.log(`\n=== PARSED SUMMARY ===`);
  console.log(JSON.stringify(summary, null, 2));
  const captureLine = report.match(/Capture file: (\S+) \(0600\)/) ?? messages.join(" | ").match(/Capture file: (\S+) \(0600\)/);
  if (captureLine) capturePath = captureLine[1];

  const durationMs = Date.now() - startedAt;
  console.log(`\nGROUND TEST DONE: PR #${prNumber}, review status ${summary.status}, ${summary.findings.length} finding(s), ${(durationMs / 1000).toFixed(1)}s wall clock (incl. session start)`);
} finally {
  cleanupSync();
  cleanedUp = true;
  await safeStop();
}
