import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export const PHASE_LIMITS = Object.freeze({
  worker: { maxTurns: 300, timeoutMs: 90 * 60_000 },
  reviewer: { maxTurns: 80, timeoutMs: 20 * 60_000 },
  fixer: { maxTurns: 150, timeoutMs: 45 * 60_000 },
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

export function buildZcodeArgs({ prompt, repoRoot, maxTurns }) {
  return [
    "--prompt", prompt,
    "--cwd", repoRoot,
    "--mode", "yolo",
    "--max-turns", String(maxTurns),
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
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5_000);
        }, timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on("close", (code) => finish(code));
    child.on("error", (error) => { stderr += String(error); finish(null); });
  });
}
