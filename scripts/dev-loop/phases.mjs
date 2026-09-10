import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export const PHASE_LIMITS = Object.freeze({
  // maxTurns is retained for I3 calibration only: zcode 0.16.5 rejects
  // --max-turns at parse time (its own --help still lists it), so the
  // wall-clock timeoutMs is the only bound actually enforced per phase.
  worker: { maxTurns: 300, timeoutMs: 90 * 60_000 },
  reviewer: { maxTurns: 80, timeoutMs: 20 * 60_000 },
  fixer: { maxTurns: 150, timeoutMs: 45 * 60_000 },
  // The dogfood review is one heavy lane over the captured diff; 20m is the
  // starting guess pending the supervised first run (I3 calibration item).
  dogfood: { maxTurns: 80, timeoutMs: 20 * 60_000 },
});

export const DEFAULT_ZCODE_CLI = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const DENIED_TOOLS = "Bash(gh pr merge *)";

export function resolveZcodeCli(env = process.env, defaultCli = DEFAULT_ZCODE_CLI) {
  if (env.ZCODE_CLI) return env.ZCODE_CLI;
  if (existsSync(defaultCli)) return defaultCli;
  throw new Error(
    `zcode CLI not found at ${defaultCli} (app moved or updated?). Set ZCODE_CLI to the zcode binary path.`,
  );
}

export function renderPrompt(template, vars) {
  return template.replace(/\{([A-Z_]+)\}/g, (marker, key) => (key in vars ? String(vars[key]) : marker));
}

// No --max-turns here: zcode 0.16.5's parser rejects it (exit 1 + usage dump)
// even though --help lists it; --settings is dead the same way. The runCommand
// timeout is the enforced bound.
export function buildZcodeArgs({ prompt, repoRoot }) {
  return [
    "--prompt", prompt,
    "--cwd", repoRoot,
    "--mode", "yolo",
    "--disallowed-tools", DENIED_TOOLS,
  ];
}

export function runCommand(command, args, { cwd, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: String(error), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        }, timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on("close", (code) => finish(code));
    child.on("error", (error) => { stderr += String(error); finish(null); });
  });
}
