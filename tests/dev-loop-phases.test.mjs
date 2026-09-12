// tests/dev-loop-phases.test.mjs
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ZCODE_CLI, PHASE_LIMITS, buildPhaseEnv, buildZcodeArgs, renderPrompt, resolveZcodeCli, runCommand,
} from "../scripts/dev-loop/phases.mjs";

describe("runCommand", () => {
  it("captures exit code and stdout", async () => {
    const result = await runCommand("/bin/echo", ["hello"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "hello");
    assert.equal(result.timedOut, false);
  });
  it("reports nonzero exit codes and stderr", async () => {
    const result = await runCommand("/bin/sh", ["-c", "echo oops >&2; exit 3"]);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /oops/);
  });
  it("kills processes that exceed the timeout", async () => {
    const start = Date.now();
    const result = await runCommand("/bin/sleep", ["30"], { timeoutMs: 300 });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - start < 10_000, "must not wait for the full sleep");
  });
  it("resolves null code on spawn error", async () => {
    const result = await runCommand("/nonexistent-binary-xyz", []);
    assert.equal(result.code, null);
    assert.ok(result.stderr.length > 0);
  });
  it("passes env through to the child when given (isolated phase HOME reaches zcode)", async () => {
    // process.execPath: an absolute binary, so the case doesn't depend on PATH
    // being present in the (deliberately minimal) child env.
    const result = await runCommand(process.execPath, ["-e", "console.log(process.env.ZPR_PHASE_PROBE)"], { env: { ZPR_PHASE_PROBE: "isolated" } });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "isolated");
  });
});

describe("buildPhaseEnv", () => {
  // A minimal fake operator HOME with just the model config.
  const withFakeHome = (fn) => async () => {
    const home = join(tmpdir(), `zpr-phase-env-test-${process.pid}-${Date.now()}`);
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    mkdirSync(join(home, ".zcode", "cli"), { recursive: true });
    writeFileSync(join(home, ".zcode", "cli", "config.json"), '{"model":"zai/glm-5.3"}');
    try {
      await fn(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };
  it("builds an isolated HOME carrying only the model config, with git/gh redirected to the real home", withFakeHome(async (home) => {
    const phase = buildPhaseEnv({ home, env: { HOME: home, ZAI_API_KEY: "k", PATH: "/usr/bin" } });
    assert.equal(phase.error, undefined);
    assert.ok(phase.env.HOME.startsWith(join(tmpdir(), "zpr-phase-home-")), "phase HOME must be a fresh temp dir");
    assert.notEqual(phase.env.HOME, home);
    assert.ok(existsSync(join(phase.env.HOME, ".zcode", "cli", "config.json")), "model config must be copied");
    assert.equal(phase.env.GIT_CONFIG_GLOBAL, join(home, ".gitconfig"));
    assert.equal(phase.env.GH_CONFIG_DIR, join(home, ".config", "gh"));
    assert.equal(phase.env.ZAI_API_KEY, "k", "auth env passes through");
    assert.equal(phase.env.PATH, "/usr/bin");
    // Git credentials pin to gh's helper (GCM prompts under the isolated HOME):
    // one reset + one gh helper entry via command-scope GIT_CONFIG_*.
    assert.equal(phase.env.GIT_CONFIG_COUNT, "2");
    assert.equal(phase.env.GIT_CONFIG_KEY_0, "credential.helper");
    assert.equal(phase.env.GIT_CONFIG_VALUE_0, "");
    assert.equal(phase.env.GIT_CONFIG_KEY_1, "credential.helper");
    assert.equal(phase.env.GIT_CONFIG_VALUE_1, "!gh auth git-credential");
    phase.cleanup();
    assert.equal(existsSync(phase.env.HOME), false, "cleanup removes the phase HOME");
  }));
  it("fails closed with a pointer to AGENTS.md when the model config is unreadable", async () => {
    const phase = buildPhaseEnv({ home: "/nonexistent-home-xyz", env: {} });
    assert.match(phase.error, /cannot read .*config\.json/);
    assert.match(phase.error, /AGENTS\.md/);
  });
});

describe("renderPrompt", () => {
  it("substitutes known keys and leaves unknown markers intact", () => {
    assert.equal(renderPrompt("Do {INCREMENT} on {PR_NUMBER} then {UNKNOWN}", { INCREMENT: "I3", PR_NUMBER: "7" }),
      "Do I3 on 7 then {UNKNOWN}");
  });
});

describe("buildZcodeArgs", () => {
  it("denies merge, pins cwd and mode — no --max-turns (zcode 0.16.5 rejects it)", () => {
    const args = buildZcodeArgs({ prompt: "work", repoRoot: "/repo" });
    const joined = args.join(" ");
    assert.match(joined, /--prompt work /);
    assert.match(joined, /--cwd \/repo /);
    assert.match(joined, /--mode yolo /);
    // Only the merge rule remains in the denylist: no denylist shape matches
    // MCP tools on zcode 0.16.5 (twice observed — I4, V1), so MCP isolation is
    // structural via buildPhaseEnv's isolated HOME, not a deny pattern.
    assert.match(joined, /--disallowed-tools Bash\(gh pr merge \*\)/);
    assert.doesNotMatch(joined, /mcp__/);
    assert.doesNotMatch(joined, /--max-turns/);
  });
});

describe("resolveZcodeCli", () => {
  it("prefers ZCODE_CLI and errors clearly without any candidate", () => {
    assert.equal(resolveZcodeCli({ ZCODE_CLI: "/custom/zcode" }), "/custom/zcode");
    // Inject a nonexistent default: the real DEFAULT_ZCODE_CLI exists on machines
    // with ZCode.app installed, so the no-candidate path is untestable via {}.
    const missingDefault = "/nonexistent/zcode-cli-xyz";
    assert.throws(() => resolveZcodeCli({}, missingDefault), new RegExp(missingDefault.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")));
  });
  it("resolves the bundled default when it exists", () => {
    assert.equal(resolveZcodeCli({}, DEFAULT_ZCODE_CLI), DEFAULT_ZCODE_CLI);
  });
});

describe("PHASE_LIMITS", () => {
  it("covers worker, reviewer, fixer with turns and timeouts", () => {
    for (const phase of ["worker", "reviewer", "fixer"]) {
      assert.ok(Number.isInteger(PHASE_LIMITS[phase].maxTurns));
      assert.ok(PHASE_LIMITS[phase].timeoutMs > 0);
    }
  });
});
