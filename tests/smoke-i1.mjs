// I1 no-inference smoke script: plugin registration + status/help + a config
// round-trip, all dispatched by RPC through a fresh CLI session. See
// smoke-harness.mjs for how the session is driven (and why `copilot -p` is
// never used).
//
// Usage:
//   node tests/smoke-i1.mjs
// Optional env: COPILOT_CLI_PATH, COPILOT_SDK_PATH (see smoke-harness.mjs).
//
// The script snapshots ~/.copilot/pr-review-glm/config.json and restores it
// (or removes it, if it did not exist) before exiting.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfigPath } from "../extensions/pr-review/config.mjs";
import { runCommand, snapshotFile, startPluginSession, stopClient, waitForCommands } from "./smoke-harness.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const configPath = defaultConfigPath();
const snapshot = snapshotFile(configPath, "config");

let client;
let cleanedUp = false;

// Node does not run `finally` blocks on default signal termination; without
// these handlers a Ctrl-C mid-run would leave smoke values in the user's
// real config file.
process.once("SIGINT", () => void exitViaSignal("SIGINT"));
process.once("SIGTERM", () => void exitViaSignal("SIGTERM"));

async function exitViaSignal(signal) {
  console.error(`\n${signal} received — restoring config state before exit.`);
  await cleanup();
  process.exit(130);
}

// Cleanup failures must surface (and fail the run) without masking the
// original failure from the try block or skipping the config restore.
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  const problems = [];
  try {
    if (client) await stopClient(client);
  } catch (error) {
    problems.push(`client stop: ${String(error)}`);
  }
  try {
    snapshot.restore();
  } catch (error) {
    problems.push(`config restore: ${String(error)}`);
  }
  for (const problem of problems) console.error(`CLEANUP PROBLEM: ${problem}`);
  if (problems.length) process.exitCode = 1;
}

try {
  const started = await startPluginSession({ repoRoot });
  client = started.client;
  const session = started.session;

  await waitForCommands(session, {
    "pr-review": "Read-only PR capture (--capture-only) plus status and help",
    "pr-review-config": "Inspect or update pr-review-glm configuration",
  });
  console.log("PASS /pr-review and /pr-review-config are registered by the plugin extension");

  const statusMessages = await runCommand(session, "pr-review", "");
  assert(statusMessages.some((m) => m.includes("pr-review-glm — parallel tiered PR review")), "bare /pr-review must print the status");
  assert(statusMessages.some((m) => m.includes("no model calls")), "status must state it makes no model calls");
  console.log("PASS bare /pr-review prints the capability boundary");

  const helpMessages = await runCommand(session, "pr-review", "help");
  assert(helpMessages.some((m) => m.includes("/pr-review — parallel tiered PR review")), "/pr-review help must print usage");
  console.log("PASS /pr-review help prints usage");

  const initialShow = await runCommand(session, "pr-review-config", "show");
  const pristineConfig = !snapshot.existed;
  if (pristineConfig) {
    assert(initialShow.some((m) => m.includes("defaultMode: balanced")), "initial show must show defaults");
    assert(initialShow.every((m) => !m.startsWith("Warning:")), "no warnings expected when no config file exists");
    assert.equal(existsSync(configPath), false, "show must not create the config file");
  } else {
    // A pre-existing user config (possibly with its own values or a warning)
    // must still render without inference; the round-trip below restores it.
    assert(initialShow.some((m) => m.includes("pr-review-glm configuration")), "show must render");
  }

  const afterSet = await runCommand(session, "pr-review-config", "defaultMode=deep tiers.heavy.model=gpt-5.6-terra");
  assert(afterSet.some((m) => m.includes("defaultMode: deep")), "set must persist defaultMode");
  assert(afterSet.some((m) => m.includes("tiers.heavy.model: gpt-5.6-terra")), "set must persist the tier model");
  const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(onDisk.defaultMode, "deep");
  assert.equal(onDisk.tiers.heavy.model, "gpt-5.6-terra");
  assert.equal(statSync(configPath).mode & 0o777, 0o600, "config file must be 0600");
  assert(
    readdirSync(dirname(configPath)).every((name) => !name.startsWith("config.json.tmp-")),
    "no temp files may linger",
  );
  console.log("PASS config set writes a 0600 file with the changed values");

  const badSet = await runCommand(session, "pr-review-config", "defaultMode=turbo");
  assert(badSet.some((m) => m.includes("Configuration not changed")), "invalid set must be rejected");
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).defaultMode, "deep", "rejected set must leave the file untouched");
  console.log("PASS invalid set is rejected and keeps the last valid file");

  const afterUnset = await runCommand(session, "pr-review-config", "unset defaultMode tiers.heavy.model");
  assert(afterUnset.some((m) => m.includes("defaultMode: balanced")), "unset must restore defaults");
  assert(afterUnset.some((m) => m.includes("tiers.heavy.model: null")), "unset must restore the tier model");
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).defaultMode, "balanced");
  console.log("PASS config unset restores defaults on disk");

  console.log("SMOKE PASS I1: registration + status/help + config round-trip, zero inference");
} finally {
  await cleanup();
}
