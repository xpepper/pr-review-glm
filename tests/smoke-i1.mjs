// I1 no-inference smoke script.
//
// Spawns a fresh Copilot CLI session via the SDK with
//   copilot --plugin-dir <repo> --experimental
// (passed as the child's CLI args), then drives the plugin's commands through
// session.rpc.commands.execute — direct dispatch, never a model prompt.
// `copilot -p "/pr-review"` is NOT used: a prompt-mode slash command starts an
// ambient model turn, which is exactly what this script must prove absent.
//
// Usage:
//   node tests/smoke-i1.mjs
// Optional env: COPILOT_CLI_PATH (default: `command -v copilot`),
//               COPILOT_SDK_PATH (default: ~/.copilot/pkg/<arch>/<version>/copilot-sdk).
//
// The script snapshots ~/.copilot/pr-review-glm/config.json and restores it
// (or removes it, if it did not exist) before exiting.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultConfigPath } from "../extensions/pr-review/config.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const cliPath = process.env.COPILOT_CLI_PATH ?? execFileSync("sh", ["-c", "command -v copilot"], { encoding: "utf8" }).trim();
const sdkPath = process.env.COPILOT_SDK_PATH ?? resolveSdkPath();

function resolveSdkPath() {
  const versionOutput = execFileSync(cliPath, ["--version"], { encoding: "utf8" });
  const version = versionOutput.match(/CLI ([0-9][0-9.]*[0-9])/)?.[1];
  assert(version, `Could not parse copilot version from: ${versionOutput}`);
  for (const arch of ["darwin-arm64", "universal", "darwin-x64"]) {
    const candidate = join(homedir(), ".copilot", "pkg", arch, version, "copilot-sdk");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Bundled copilot-sdk not found for CLI ${version}; set COPILOT_SDK_PATH`);
}

const { CopilotClient, RuntimeConnection } = await import(
  pathToFileURL(join(sdkPath, "index.js")).href
);

const configPath = defaultConfigPath();
const snapshot = snapshotConfig();

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
    if (client) {
      const errors = await client.stop();
      assert.deepEqual(errors, [], "client.stop() must be clean");
    }
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
  client = new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: resolve(cliPath),
      args: ["--plugin-dir", repoRoot, "--experimental"],
    }),
  });
  const session = await client.createSession({
    enableExperimentalMode: true,
    requestExtensions: true,
    enableConfigDiscovery: true,
    availableTools: [],
    onPermissionRequest: async () => ({ kind: "denied-no-approval-rule" }),
    workingDirectory: repoRoot,
  });

  await waitForCommands(session, {
    "pr-review": "Show the pr-review-glm capability boundary",
    "pr-review-config": "Inspect or update pr-review-glm configuration",
  }, 30_000);
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

// Waits until every expected command is registered with this plugin's exact
// description. Matching descriptions (not just names) makes a command-name
// collision with another plugin fail loudly instead of dispatching to it.
async function waitForCommands(session, expectedByName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { commands } = await session.rpc.commands.list();
    const registered = Object.entries(expectedByName).filter(([name, description]) =>
      commands.some((command) => command.name === name && command.description.startsWith(description))
    );
    if (registered.length === Object.keys(expectedByName).length) return;
    if (Date.now() > deadline) {
      const seen = commands.map((c) => `${c.name} (${c.description.slice(0, 40)})`).join("; ") || "(none)";
      throw new Error(`Timed out waiting for plugin commands; registered: ${seen}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Executes a command by direct RPC and proves no inference happened: the only
// new events must be session logging, never a model turn or tool execution.
async function runCommand(session, commandName, args) {
  const before = (await session.getEvents()).length;
  const result = await session.rpc.commands.execute({ commandName, args });
  assert.equal(result.error, undefined, `${commandName} ${args} failed: ${result.error}`);
  const events = (await session.getEvents()).slice(before);
  const inference = events.filter((event) =>
    event.type === "user.message" ||
    event.type.startsWith("assistant.") ||
    event.type.startsWith("model.") ||
    event.type.startsWith("subagent.") ||
    event.type === "tool.execution_start" ||
    event.type === "session.usage_checkpoint"
  );
  assert.deepEqual(inference.map((e) => e.type), [], `${commandName} ${args} must not start inference`);
  return events
    .filter((event) => event.type === "session.info" || event.type === "session.error")
    .map((event) => event.data.message);
}

function snapshotConfig() {
  const existed = existsSync(configPath);
  const original = existed ? readFileSync(configPath, "utf8") : undefined;
  const dirExisted = existsSync(dirname(configPath));
  return {
    restore() {
      if (existed) {
        writeFileSync(configPath, original, { mode: 0o600 });
      } else {
        rmSync(configPath, { force: true });
      }
      if (!dirExisted && existsSync(dirname(configPath)) && readdirSync(dirname(configPath)).length === 0) {
        rmSync(dirname(configPath), { recursive: true, force: true });
      }
      assert.equal(existsSync(configPath), existed, "smoke must restore the prior config-file state");
      if (existed) assert.equal(readFileSync(configPath, "utf8"), original, "restored config content must match byte-for-byte");
      console.log(`PASS config state restored (pre-existing file: ${existed})`);
    },
  };
}
