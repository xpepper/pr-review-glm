// tests/dev-loop-cli.test.mjs
// CLI arg validation for --merge (L2): like --dogfood, an explicit value is
// required and anything else exits 2 before any phase is dispatched. Only the
// fast-failing paths and --help are spawned here; valid non-dry-run invocations
// would start a real iteration and belong to the supervised runs.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runCommand } from "../scripts/dev-loop/phases.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function runCli(args) {
  return runCommand("node", ["scripts/dev-loop.mjs", ...args], { cwd: repoRoot, timeoutMs: 30_000 });
}

describe("dev-loop CLI --merge", () => {
  it("requires an explicit human|auto value; missing or invalid exits 2", async () => {
    for (const args of [["--merge"], ["--merge", "robot"]]) {
      const result = await runCli(args);
      assert.equal(result.code, 2, `expected exit 2 for: ${args.join(" ")}`);
      assert.match(result.stderr, /--merge requires an explicit human\|auto value/);
    }
  });
  it("usage documents --merge human|auto alongside the other flags", async () => {
    const result = await runCli(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /--merge human\|auto/);
  });
});
