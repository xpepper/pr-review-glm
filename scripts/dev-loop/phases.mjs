import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
// Merge denial stays a denylist rule (the help's own example shape). MCP/tools
// isolation moved OUT of this flag: observed twice (I4 2026-09-11, V1 2026-09-11
// — reviewer agents invoked playwright MCP tools and popped a visible
// automation Chrome) that no denylist shape matches MCP tools on zcode 0.16.5 —
// `mcp__*`, bare server names, and exact server names are all parser-accepted
// and all ineffective, and the `--allowed-tools` allowlist the help lists is
// parser-dead exactly like --max-turns/--settings. The structural fix is
// buildPhaseEnv below: an isolated HOME with only the model config, so MCP
// servers, plugins, and skills never exist in a phase environment.
const DENIED_TOOLS = "Bash(gh pr merge *)";

// Phase agents run headless with an isolated HOME containing ONLY
// ~/.zcode/cli/config.json (the verified model+provider config). Everything
// else the operator's HOME carries — MCP servers, plugins, skills — never
// exists for a phase, so none can spawn (the Chrome incident class is
// structurally impossible rather than denied-and-hoped). Git identity and gh
// auth stay real through documented env redirection, and the API key rides the
// environment as before. The zcode-headless preflight gate probes this exact
// env shape before any phase is dispatched.
// gh auth, pinned to a token the isolated HOME can use. The operator's gh
// stores its token in the macOS keyring, and gh's keyring read FAILS under a
// redirected HOME (verified 2026-09-12: `gh auth status` with a fake HOME
// reports "The token in default is invalid", with a real HOME it is fine —
// so #25's GIT_CONFIG_* helper pin still left the helper answerless, and the
// V1 run 3/4 fixers hit interactive "Username for 'https://github.com'"
// prompts mid-push). GH_TOKEN is gh's documented top-priority auth source and
// bypasses the keyring entirely: resolve it once here, in the OPERATOR's env
// where the keyring works, and carry it into the phase env. The phase agents
// are the operator's own agents on the operator's machine; the token was
// already reachable from any phase via gh under the pre-#24 real HOME.
function resolveGhToken(env) {
  try {
    return { token: execSync("gh auth token", { env, encoding: "utf8" }).trim() };
  } catch (error) {
    return { error: `gh auth token failed (the loop must run where gh is logged in): ${String(error.message ?? error).slice(0, 200)}` };
  }
}

export function buildPhaseEnv({
  home = process.env.HOME,
  env = process.env,
  mkdtemp = mkdtempSync,
  resolveToken = resolveGhToken,
} = {}) {
  const sourceConfig = join(home, ".zcode", "cli", "config.json");
  let configText;
  try {
    configText = readFileSync(sourceConfig, "utf8");
  } catch {
    return { error: `cannot read ${sourceConfig} — headless phases need the operator's model config; see AGENTS.md (Environment facts — zcode CLI)` };
  }
  const ghToken = resolveToken(env);
  if (ghToken.error) return { error: ghToken.error };
  if (!ghToken.token) {
    return { error: "gh auth token returned empty — log in with gh in the shell that launches the loop" };
  }
  const phaseHome = mkdtemp(join(tmpdir(), "zpr-phase-home-"));
  mkdirSync(join(phaseHome, ".zcode", "cli"), { recursive: true });
  writeFileSync(join(phaseHome, ".zcode", "cli", "config.json"), configText);
  return {
    env: {
      ...env,
      HOME: phaseHome,
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      GH_CONFIG_DIR: join(home, ".config", "gh"),
      // Phase gh auth: the token rides the env (keyring is unreachable under
      // the redirected HOME), so `gh` commands and the git credential helper
      // below both authenticate deterministically, no prompts.
      GH_TOKEN: ghToken.token,
      // Git credentials, pinned to gh's helper. The operator's helper chain
      // (observed: osxkeychain, a reset line, then git-credential-manager)
      // breaks under the isolated HOME — GCM has no config there and falls
      // back to interactive prompting. These GIT_CONFIG_* entries are
      // command-scope config: the empty value resets whatever the global file
      // accumulated, then exactly one helper remains — gh's, which answers
      // from GH_TOKEN above. Phase pushes/fetches become deterministic.
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "!gh auth git-credential",
    },
    cleanup: () => rmSync(phaseHome, { recursive: true, force: true }),
  };
}

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

export function runCommand(command, args, { cwd, timeoutMs, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // env omitted → inherit the operator's environment (git/gh/plain tests);
      // phase invocations pass the isolated-HOME env from buildPhaseEnv.
      child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
