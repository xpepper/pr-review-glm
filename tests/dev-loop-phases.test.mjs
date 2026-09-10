// tests/dev-loop-phases.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_ZCODE_CLI, PHASE_LIMITS, buildZcodeArgs, renderPrompt, resolveZcodeCli, runCommand,
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
});

describe("renderPrompt", () => {
  it("substitutes known keys and leaves unknown markers intact", () => {
    assert.equal(renderPrompt("Do {INCREMENT} on {PR_NUMBER} then {UNKNOWN}", { INCREMENT: "I3", PR_NUMBER: "7" }),
      "Do I3 on 7 then {UNKNOWN}");
  });
});

describe("buildZcodeArgs", () => {
  it("denies merge and pins cwd and mode — no --max-turns (zcode 0.16.5 rejects it)", () => {
    const args = buildZcodeArgs({ prompt: "work", repoRoot: "/repo" });
    const joined = args.join(" ");
    assert.match(joined, /--prompt work /);
    assert.match(joined, /--cwd \/repo /);
    assert.match(joined, /--mode yolo /);
    assert.match(joined, /--disallowed-tools Bash\(gh pr merge \*\)/);
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
