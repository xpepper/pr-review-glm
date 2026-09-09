// Shared harness for the no-inference smoke scripts.
//
// Spawns a fresh Copilot CLI session via the SDK with
//   copilot --plugin-dir <repo> --experimental
// (passed as the child's CLI args), then drives the plugin's commands through
// session.rpc.commands.execute — direct dispatch, never a model prompt.
// `copilot -p "/pr-review"` is NOT used: a prompt-mode slash command starts an
// ambient model turn, which is exactly what the smokes must prove absent.
//
// Scripts keep their own scenario, signal handling, and cleanup; this module
// owns the session lifecycle, command dispatch, and the no-inference assertion.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function resolveCliPath() {
  return (
    process.env.COPILOT_CLI_PATH ??
    execFileSync("sh", ["-c", "command -v copilot"], { encoding: "utf8" }).trim()
  );
}

export function resolveSdkPath(cliPath) {
  if (process.env.COPILOT_SDK_PATH) return process.env.COPILOT_SDK_PATH;
  const versionOutput = execFileSync(cliPath, ["--version"], { encoding: "utf8" });
  const version = versionOutput.match(/CLI ([0-9][0-9.]*[0-9])/)?.[1];
  assert(version, `Could not parse copilot version from: ${versionOutput}`);
  for (const arch of ["darwin-arm64", "universal", "darwin-x64"]) {
    const candidate = join(homedir(), ".copilot", "pkg", arch, version, "copilot-sdk");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Bundled copilot-sdk not found for CLI ${version}; set COPILOT_SDK_PATH`);
}

export async function startPluginSession({ repoRoot, cliPath = resolveCliPath(), sdkPath = null }) {
  const { CopilotClient, RuntimeConnection } = await import(
    pathToFileURL(join(sdkPath ?? resolveSdkPath(cliPath), "index.js")).href
  );
  const client = new CopilotClient({
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
  return { client, session };
}

export async function stopClient(client) {
  const errors = await client.stop();
  assert.deepEqual(errors, [], "client.stop() must be clean");
}

// Waits until every expected command is registered with this plugin's exact
// description. Matching descriptions (not just names) makes a command-name
// collision with another plugin fail loudly instead of dispatching to it.
export async function waitForCommands(session, expectedByName, timeoutMs = 30_000) {
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
// Returns the session.info / session.error messages the command produced.
export async function runCommand(session, commandName, args) {
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

// Snapshots a file so a smoke script can mutate it and restore the exact prior
// state (byte-for-byte, or absent) before exiting.
export function snapshotFile(path, label = "file") {
  const existed = existsSync(path);
  const original = existed ? readFileSync(path, "utf8") : undefined;
  const dirExisted = existsSync(join(path, ".."));
  return {
    restore() {
      if (existed) {
        writeFileSync(path, original, { mode: 0o600 });
      } else {
        rmSync(path, { force: true });
      }
      if (!dirExisted && existsSync(join(path, "..")) && readdirSync(join(path, "..")).length === 0) {
        rmSync(join(path, ".."), { recursive: true, force: true });
      }
      assert.equal(existsSync(path), existed, `smoke must restore the prior ${label} state`);
      if (existed) {
        assert.equal(readFileSync(path, "utf8"), original, `restored ${label} content must match byte-for-byte`);
      }
      console.log(`PASS ${label} state restored (pre-existing file: ${existed})`);
    },
  };
}
