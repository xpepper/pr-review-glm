// I2 no-inference smoke script: /pr-review N --capture-only dispatched by RPC
// against a real PR of this repository. Proves capture is pure code over `gh`:
// real metadata/diff land in a 0600 file with the repo binding frozen, and the
// session event stream shows zero inference (harness assertion in runCommand).
//
// Usage:
//   node tests/smoke-i2.mjs
// Env: SMOKE_PR_NUMBER (default 3 — a merged PR of this repo),
//      SMOKE_PR_CLOSED (default 1; set 0 for an open PR, which drops
//        --include-closed and the closed-gate refusal step),
//      COPILOT_CLI_PATH / COPILOT_SDK_PATH (see smoke-harness.mjs).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CAPTURE_SCHEMA_VERSION } from "../extensions/pr-review/capture.mjs";
import { runCommand, startPluginSession, stopClient, waitForCommands } from "./smoke-harness.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const prNumber = Number(process.env.SMOKE_PR_NUMBER ?? 3);
const prClosed = process.env.SMOKE_PR_CLOSED !== "0";
const expectedRepo = JSON.parse(
  execFileSync("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd: repoRoot, encoding: "utf8" }),
).nameWithOwner;

let client;
let capturePath = null;
let cleanedUp = false;

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

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  cleanupSync();
  await safeStop();
}

try {
  const started = await startPluginSession({ repoRoot });
  client = started.client;
  const session = started.session;

  await waitForCommands(session, {
    "pr-review": "Read-only PR capture (--capture-only) plus status and help",
  });
  console.log("PASS /pr-review is registered by the plugin extension");

  if (prClosed) {
    const refused = await runCommand(session, "pr-review", `${prNumber} --capture-only`);
    assert(
      refused.some((m) => m.includes("Skipped") && m.includes("--include-closed")),
      `capturing closed PR #${prNumber} without --include-closed must be skipped, got: ${refused.join(" | ")}`,
    );
    console.log(`PASS closed-gate refusal for PR #${prNumber} (no --include-closed)`);
  }

  const captureMessages = await runCommand(
    session,
    "pr-review",
    `${prNumber} --capture-only${prClosed ? " --include-closed" : ""}`,
  );
  assert(
    captureMessages.some((m) => m.includes(`Captured PR #${prNumber}`)),
    `capture must report PR #${prNumber}, got: ${captureMessages.join(" | ")}`,
  );
  assert(captureMessages.some((m) => m.includes("No model calls")), "capture must state zero inference");
  const fileMessage = captureMessages.find((m) => m.includes("Capture file:"));
  assert(fileMessage, "capture must report the capture file");
  capturePath = /Capture file: (\S+) \(0600\)/.exec(fileMessage)?.[1];
  assert(capturePath, `could not parse the capture path from: ${fileMessage}`);
  console.log(`PASS PR #${prNumber} captured via gh into a temp file`);

  assert.equal(statSync(capturePath).mode & 0o777, 0o600, "capture file must be 0600");
  const envelope = JSON.parse(readFileSync(capturePath, "utf8"));
  assert.equal(envelope.kind, "pr-review-glm-capture");
  assert.equal(envelope.schemaVersion, CAPTURE_SCHEMA_VERSION);
  assert.equal(envelope.repo, expectedRepo, "the frozen repo binding must match this repository");
  assert.equal(envelope.pr.number, prNumber);
  assert.equal(typeof envelope.pr.head.oid, "string");
  assert(envelope.diff.length > 0, "the real diff must be embedded");
  console.log(`PASS capture envelope is well-formed and bound to ${expectedRepo} (diff ${envelope.diff.length} chars)`);

  const statusMessages = await runCommand(session, "pr-review", "status");
  assert(
    statusMessages.some((m) => m.includes("Last capture (this session)") && m.includes(`PR #${prNumber}`)),
    "status must report the session's capture",
  );
  console.log("PASS /pr-review status reports the last capture");

  console.log(`SMOKE PASS I2: PR #${prNumber} captured read-only via gh, zero inference`);
} finally {
  await cleanup();
}
