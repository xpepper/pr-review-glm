// tests/dev-loop-gates.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  gateBranchHead, gateDocsUpdated, gateIncrementPr, gateMainGreen, gatePrototypeAbsent,
  gateRepoIdle, gateSmokes, gateTests, gateZcodeHeadless, reportGates,
} from "../scripts/dev-loop/gates.mjs";

const repoRoot = "/repo"; // never touched: all commands are faked
// gateTests/gateSmokes/gateMainGreen enumerate the real tests/ dir (readdirSync)
// while faking execution, so they need the real repo root.
const realRoot = fileURLToPath(new URL("..", import.meta.url));
const runOk = (stdout = "") => async () => ({ code: 0, stdout, stderr: "" });

describe("gateRepoIdle", () => {
  // One constant stdout cannot express a clean tree + synced main + no PRs, so
  // the idle fake dispatches per command. On-main is the default so each
  // failure case exercises its own condition.
  const idleRun = (outputs) => async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    const result = outputs[key];
    if (result) return result;
    if (key === "git rev-parse --abbrev-ref HEAD") return { code: 0, stdout: "main\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  it("passes on clean synced repo with no open PRs", async () => {
    const run = idleRun({
      "git rev-parse main origin/main": { code: 0, stdout: "commit-a\ncommit-a\n", stderr: "" },
      "gh pr list --state open --json number,headRefName": { code: 0, stdout: "[]", stderr: "" },
    });
    const gate = await gateRepoIdle({ run, repoRoot });
    assert.deepEqual(gate, { name: "repo-idle", ok: true, detail: "main clean, synced, no open PRs" });
  });
  it("fails on non-main checkout, dirty tree, desync, fetch failure, or open PRs", async () => {
    const cases = [
      idleRun({ "git rev-parse --abbrev-ref HEAD": { code: 0, stdout: "l1-dev-loop\n", stderr: "" } }),
      idleRun({ "git status --porcelain": { code: 0, stdout: " M file\n", stderr: "" } }),
      idleRun({ "git rev-parse main origin/main": { code: 0, stdout: "aaa\nbbb\n", stderr: "" } }),
      idleRun({ "git fetch --quiet origin": { code: 1, stdout: "", stderr: "network down" } }),
      idleRun({ "gh pr list --state open --json number,headRefName": { code: 0, stdout: '[{"number":7,"headRefName":"x"}]', stderr: "" } }),
    ];
    for (const run of cases) {
      const gate = await gateRepoIdle({ run, repoRoot });
      assert.equal(gate.ok, false);
    }
  });
});

describe("gatePrototypeAbsent", () => {
  it("passes when the prototype is gone, fails when registered or list fails", async () => {
    assert.equal((await gatePrototypeAbsent({ run: runOk("superpowers\n") })).ok, true);
    const registered = await gatePrototypeAbsent({ run: runOk("copilot-pr-review (v0.0.1)\n") });
    assert.equal(registered.ok, false);
    assert.match(registered.detail, /copilot plugin uninstall copilot-pr-review/);
    assert.equal((await gatePrototypeAbsent({ run: async () => ({ code: 1, stdout: "", stderr: "boom" }) })).ok, false);
  });
});

describe("gateTests", () => {
  it("runs node --test with the explicit test files it discovered", async () => {
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    assert.equal((await gateTests({ run, repoRoot: realRoot })).ok, true);
    const flat = calls.flat().join(" ");
    assert.match(flat, /node/);
    assert.match(flat, /--test/);
    assert.match(flat, /dev-loop-status\.test\.mjs/);
    assert.doesNotMatch(flat, /smoke-harness/);
  });
  it("fails on nonzero test exit", async () => {
    assert.equal((await gateTests({ run: async () => ({ code: 1, stdout: "", stderr: "failing" }), repoRoot: realRoot })).ok, false);
  });
});

describe("gateSmokes", () => {
  it("excludes the named smoke scripts, skips the shared harness, and fails on nonzero exits", async () => {
    const calls = [];
    const run = async (command, args) => { calls.push(args.join(" ")); return { code: 0, stdout: "", stderr: "" }; };
    await gateSmokes({ run, repoRoot: realRoot, exclude: ["smoke-l1.mjs"] });
    for (const call of calls) assert.doesNotMatch(call, /smoke-l1/);
    for (const call of calls) assert.doesNotMatch(call, /smoke-harness/);
    assert(calls.some((c) => c.includes("smoke-i1.mjs")));
    const failing = await gateSmokes({ run: async () => ({ code: 2, stdout: "", stderr: "x" }), repoRoot: realRoot, exclude: [] });
    assert.equal(failing.ok, false);
  });
});

describe("gateZcodeHeadless", () => {
  it("passes when a probe turn exits 0, probing the exact worker arg set", async () => {
    const spawned = [];
    const run = async (command, args) => {
      spawned.push([command, ...args].join(" "));
      return { code: 0, stdout: "ok\n", stderr: "" };
    };
    // No injected buildArgs: the gate must use the real buildZcodeArgs so the
    // probe exercises the same flags a worker phase would send.
    const gate = await gateZcodeHeadless({ run, zcode: "node", repoRoot });
    assert.equal(gate.ok, true);
    const probe = spawned[0];
    assert.match(probe, /--prompt Reply with the single word: ok /);
    assert.match(probe, new RegExp(`--cwd ${repoRoot} `));
    assert.match(probe, /--mode yolo /);
    assert.match(probe, /--disallowed-tools Bash\(gh pr merge \*\)/);
    assert.doesNotMatch(probe, /--max-turns/);
  });
  it("fails with the CLI's first error line when the probe exits nonzero (flags, config, auth)", async () => {
    const run = async () => ({ code: 1, stdout: "", stderr: "Error: Model config is missing. Create ~/.zcode/cli/config.json ...\n" });
    const gate = await gateZcodeHeadless({ run, zcode: "node", repoRoot });
    assert.equal(gate.ok, false);
    assert.match(gate.detail, /Model config is missing/);
    assert.match(gate.detail, /zcode login/);
  });
  it("fails on a timed-out probe", async () => {
    const run = async () => ({ code: null, stdout: "", stderr: "", timedOut: true });
    const gate = await gateZcodeHeadless({ run, zcode: "node", repoRoot });
    assert.equal(gate.ok, false);
    assert.match(gate.detail, /timedOut=true/);
  });
});

describe("gateBranchHead", () => {
  const OID = "a".repeat(40);
  // Unlisted commands succeed silently; each case pins only what it exercises.
  const dispatch = (outputs) => async (command, args) =>
    outputs[`${command} ${args.join(" ")}`] ?? { code: 0, stdout: "", stderr: "" };
  it("passes when the checkout lands exactly on the assessed head", async () => {
    const run = dispatch({ "git rev-parse HEAD": { code: 0, stdout: `${OID}\n`, stderr: "" } });
    const gate = await gateBranchHead({ run, repoRoot, headRefName: "i3-lanes", headRefOid: OID });
    assert.equal(gate.ok, true);
    assert.match(gate.detail, /at PR head/);
  });
  it("fails on checkout, fetch, or ff-only sync failures", async () => {
    const cases = [
      dispatch({ "git checkout i3-lanes": { code: 1, stdout: "", stderr: "no such branch" } }),
      dispatch({ "git fetch --quiet origin": { code: 1, stdout: "", stderr: "network down" } }),
      dispatch({ "git merge --ff-only origin/i3-lanes": { code: 1, stdout: "", stderr: "not possible to fast-forward" } }),
    ];
    for (const run of cases) {
      const gate = await gateBranchHead({ run, repoRoot, headRefName: "i3-lanes", headRefOid: OID });
      assert.equal(gate.ok, false, gate.detail);
    }
  });
  it("fails when the local head differs from the assessed head (stale or ahead)", async () => {
    const run = dispatch({ "git rev-parse HEAD": { code: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" } });
    const gate = await gateBranchHead({ run, repoRoot, headRefName: "i3-lanes", headRefOid: OID });
    assert.equal(gate.ok, false);
    assert.match(gate.detail, /not at PR head/);
  });
  it("fails with a precise message when the PR has no valid headRefOid", async () => {
    for (const headRefOid of [undefined, null, "too-short"]) {
      const gate = await gateBranchHead({ run: dispatch({}), repoRoot, headRefName: "i3-lanes", headRefOid });
      assert.equal(gate.ok, false);
      assert.match(gate.detail, /no valid headRefOid/);
    }
  });
});

describe("gateIncrementPr", () => {
  it("requires exactly one open PR and surfaces its number, branch, and reviewed head", async () => {
    const seen = [];
    const run = async (command, args) => {
      seen.push(args.join(" "));
      return { code: 0, stdout: `[{"number":7,"headRefName":"i3-lanes","headRefOid":"${"a".repeat(40)}"}]`, stderr: "" };
    };
    const one = await gateIncrementPr({ run, repoRoot });
    assert.equal(one.ok, true);
    assert.equal(one.prNumber, 7);
    assert.equal(one.headRefName, "i3-lanes");
    assert.equal(one.headRefOid, "a".repeat(40));
    // The head pin (L2) depends on gh returning headRefOid, so the field must be requested.
    assert.match(seen[0], /--json number,headRefName,url,headRefOid/);
    for (const stdout of ["[]", '[{"number":1,"headRefName":"a"},{"number":2,"headRefName":"b"}]']) {
      assert.equal((await gateIncrementPr({ run: runOk(stdout), repoRoot })).ok, false);
    }
  });
});

describe("gateDocsUpdated", () => {
  const roadmap = "| I3 | ⬜ Pending | lanes | I2 |\n| L1 | ✅ Done (PR #9) | dev-loop | I2 |\n";
  const readFileSync = (path) => path.endsWith("ROADMAP.md") ? roadmap : "# HANDOFF\n\nSTATUS: next=I3\n";
  it("passes when the increment row is done and STATUS points at a different pending increment", async () => {
    const gate = await gateDocsUpdated({ readFileSync, repoRoot, increment: "L1" });
    assert.equal(gate.ok, true);
    assert.equal(gate.nextIncrement, "I3");
  });
  it("fails when the row is not done, or STATUS is missing/same/already-done/blocked", async () => {
    const notDoneR = (path) => path.endsWith("ROADMAP.md") ? "| L1 | ⬜ Pending | x | I2 |\n" : "STATUS: next=I3\n";
    assert.equal((await gateDocsUpdated({ readFileSync: notDoneR, repoRoot, increment: "L1" })).ok, false);
    const noStatus = (path) => path.endsWith("ROADMAP.md") ? roadmap : "# HANDOFF\n";
    assert.equal((await gateDocsUpdated({ readFileSync: noStatus, repoRoot, increment: "L1" })).ok, false);
    const sameNext = (path) => path.endsWith("ROADMAP.md") ? roadmap : "STATUS: next=L1\n";
    assert.equal((await gateDocsUpdated({ readFileSync: sameNext, repoRoot, increment: "L1" })).ok, false);
    const doneNext = (path) => path.endsWith("ROADMAP.md") ? roadmap : "STATUS: next=I2\n"; // I2 absent from this fixture roadmap
    assert.equal((await gateDocsUpdated({ readFileSync: doneNext, repoRoot, increment: "L1" })).ok, false);
    const blocked = (path) => path.endsWith("ROADMAP.md") ? roadmap : "STATUS: blocked: stuck\n";
    assert.equal((await gateDocsUpdated({ readFileSync: blocked, repoRoot, increment: "L1" })).ok, false);
  });
  it("accepts STATUS done as the final-increment state after a ✅ row", async () => {
    const readFileSync = (path) => path.endsWith("ROADMAP.md") ? roadmap : "STATUS: done\n";
    const gate = await gateDocsUpdated({ readFileSync, repoRoot, increment: "L1" });
    assert.equal(gate.ok, true);
    assert.equal(gate.nextIncrement, null);
    assert.match(gate.detail, /done/);
  });
});

describe("gateMainGreen", () => {
  it("runs tests and smokes (excluding the dry-run smoke)", async () => {
    const calls = [];
    const run = async (command, args) => { calls.push(args.join(" ")); return { code: 0, stdout: "", stderr: "" }; };
    assert.equal((await gateMainGreen({ run, repoRoot: realRoot })).ok, true);
    assert(calls.some((c) => c.includes("--test")));
    for (const call of calls) assert.doesNotMatch(call, /smoke-l1/);
  });
});

describe("reportGates", () => {
  it("renders PASS/FAIL per gate", () => {
    const text = reportGates([{ name: "a", ok: true, detail: "fine" }, { name: "b", ok: false, detail: "broken" }]);
    assert.match(text, /PASS a — fine/);
    assert.match(text, /FAIL b — broken/);
  });
});
