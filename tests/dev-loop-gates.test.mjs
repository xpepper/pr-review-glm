// tests/dev-loop-gates.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  gateBranchHead, gateDocsUpdated, gateIncrementPr, gateMainGreen,
  gateRepoIdle, gateSmokes, gateTests, gateZcodeHeadless, mergeabilityGate, reportGates, runPreflightGates,
} from "../scripts/dev-loop/gates.mjs";
import { persistPhaseOutput } from "../scripts/dev-loop/phases.mjs";

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

  it("retries a failed smoke exactly once and passes with the retry disclosed", async () => {
    const calls = [];
    const run = async (command, args) => {
      calls.push(args.join(" "));
      const isTarget = args[0]?.includes("smoke-i1.mjs");
      const first = isTarget && calls.filter((c) => c.includes("smoke-i1.mjs")).length === 1;
      return first
        ? { code: 1, stdout: "PASS one", stderr: "AssertionError [ERR_ASSERTION]: capture must report PR #3, got: refused" }
        : { code: 0, stdout: "PASS", stderr: "" };
    };
    const gate = await gateSmokes({ run, repoRoot: realRoot, exclude: ["smoke-l1.mjs"] });
    assert.equal(gate.ok, true);
    assert.match(gate.detail, /retried once after failure: smoke-i1\.mjs/);
    assert.match(gate.detail, /first attempt: PASS one \| stderr: AssertionError/);
    assert.equal(calls.filter((c) => c.includes("smoke-i1.mjs")).length, 2, "exactly one retry");
    for (const other of calls.filter((c) => !c.includes("smoke-i1.mjs"))) {
      assert.equal(calls.filter((c) => c === other).length, 1, "healthy smokes run once");
    }
  });

  it("fails with stderr in the detail when the retry fails too", async () => {
    const run = async () => ({ code: 1, stdout: "PASS lines only", stderr: "AssertionError: capture must report PR #3, got: timeout", timedOut: false });
    const gate = await gateSmokes({ run, repoRoot: realRoot, exclude: [] });
    assert.equal(gate.ok, false);
    assert.match(gate.detail, /stderr: AssertionError: capture must report/);
  });
});

describe("gateZcodeHeadless", () => {
  it("passes when the probe echoes the env-carried token, probing the exact worker arg set", async () => {
    const spawned = [];
    let probeEnv;
    const run = async (command, args, opts) => {
      spawned.push([command, ...args].join(" "));
      probeEnv = opts.env;
      // The stub behaves like a real child: the token exists only in the
      // environment, and only actually executing the command would produce it.
      return { code: 0, stdout: `${opts.env.ZPR_PROBE_TOKEN}\n`, stderr: "" };
    };
    // No injected buildArgs: the gate must use the real buildZcodeArgs so the
    // probe exercises the same flags a worker phase would send.
    const gate = await gateZcodeHeadless({ run, zcode: "node", repoRoot, persist: () => ({}) });
    assert.equal(gate.ok, true);
    assert.match(gate.detail, /execution in the child env exercised/);
    const probe = spawned[0];
    // Goal-phrased prompt (2026-09-13 diagnostic): prescribing "your shell
    // tool" anchored shell-less top-level sessions on the missing tool so
    // they refused instead of delegating — the phrasing must stay
    // mechanism-neutral about HOW the command runs.
    assert.match(probe, /--prompt Use a shell to run: echo \$ZPR_PROBE_TOKEN — show me the exact output/);
    assert.doesNotMatch(probe, /your shell tool/);
    assert.match(probe, new RegExp(`--cwd ${repoRoot} `));
    assert.match(probe, /--mode yolo /);
    assert.match(probe, /--disallowed-tools Bash\(gh pr merge \*\)/);
    assert.doesNotMatch(probe, /--max-turns/);
    // The token rides the environment only: a session that never executes
    // anything in the child env cannot know it (PR #32 review hardening —
    // a computed fixed marker was guessable without a shell).
    assert.match(probeEnv.ZPR_PROBE_TOKEN, /^zpr-probe-[0-9a-f]{32}$/);
    assert.ok(!probe.includes(probeEnv.ZPR_PROBE_TOKEN), "the token must never appear in the prompt or argv");
  });
  it("fails closed when a code-0 probe replies without the token (unexpanded variable, a guess, or prose)", async () => {
    for (const stdout of ["$ZPR_PROBE_TOKEN\n", "zpr-probe-abc123\n", "I would run echo $ZPR_PROBE_TOKEN, but I have no shell tool in this session.\n"]) {
      const run = async () => ({ code: 0, stdout, stderr: "" });
      const gate = await gateZcodeHeadless({ run, zcode: "node", repoRoot, persist: () => ({}) });
      assert.equal(gate.ok, false);
      assert.match(gate.detail, /phase TOOLSET/);
    }
  });
  it("fails closed with the session's own words when a code-0 probe cannot exercise the shell tool", async () => {
    const run = async () => ({ code: 0, stdout: "I don't have a shell tool available in this session, so I cannot run the command.\n", stderr: "" });
    const gate = await gateZcodeHeadless({ run, zcode: "node", repoRoot, persist: () => ({}) });
    assert.equal(gate.ok, false);
    assert.match(gate.detail, /I don't have a shell tool available/);
    assert.match(gate.detail, /phase TOOLSET/);
  });
  it("quotes the session's stdout reply over stderr noise: an AI SDK warning must not mask the refusal (2026-09-13)", async () => {
    const run = async () => ({
      code: 0,
      stdout: "I can't run that: this session has no shell/Bash tool available to me.\n",
      stderr: 'AI SDK Warning (anthropic.messages / glm-5.3): The feature "cacheControl breakpoint limit" is not supported. Maximum 4 cache breakpoints exceeded (found 5). This breakpoint will be ignored.\n',
    });
    const gate = await gateZcodeHeadless({ run, zcode: "node", repoRoot, persist: () => ({}) });
    assert.equal(gate.ok, false);
    assert.match(gate.detail, /no shell\/Bash tool available/);
    assert.doesNotMatch(gate.detail, /AI SDK Warning/);
  });
  it("fails with the CLI's first error line when the probe exits nonzero (flags, config, auth)", async () => {
    const run = async () => ({ code: 1, stdout: "", stderr: "Error: Model config is missing. Create ~/.zcode/cli/config.json ...\n" });
    const gate = await gateZcodeHeadless({ run, zcode: "node", repoRoot, persist: () => ({}) });
    assert.equal(gate.ok, false);
    assert.match(gate.detail, /Model config is missing/);
    assert.match(gate.detail, /zcode login/);
  });
  it("fails on a timed-out probe", async () => {
    const run = async () => ({ code: null, stdout: "", stderr: "", timedOut: true });
    const gate = await gateZcodeHeadless({ run, zcode: "node", repoRoot, persist: () => ({}) });
    assert.equal(gate.ok, false);
    assert.match(gate.detail, /timedOut=true/);
  });
  it("retries the probe: a refusal followed by a token echo passes on attempt 2 with a FRESH token per attempt", async () => {
    const attempts = [];
    const run = async (command, args, opts) => {
      attempts.push(opts.env.ZPR_PROBE_TOKEN);
      if (attempts.length === 1) return { code: 0, stdout: "I don't have a shell tool available in this session.\n", stderr: "" };
      // Behaves like a real child: only executing in this env produces the token.
      return { code: 0, stdout: `${opts.env.ZPR_PROBE_TOKEN}\n`, stderr: "" };
    };
    const gate = await gateZcodeHeadless({ run, zcode: "node", repoRoot, persist: () => ({}) });
    assert.equal(gate.ok, true);
    assert.match(gate.detail, /attempt 2\/3/);
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0], attempts[1], "each attempt carries its own token");
  });
  it("fails closed only after every attempt failed, quoting the LAST attempt and the attempt count", async () => {
    let calls = 0;
    const run = async () => { calls += 1; return { code: 0, stdout: "I can't run that: this session has no shell tool available.\n", stderr: "" }; };
    const gate = await gateZcodeHeadless({ run, zcode: "node", repoRoot, persist: () => ({}) });
    assert.equal(gate.ok, false);
    assert.equal(calls, 3);
    assert.match(gate.detail, /after 3 attempts/);
    assert.match(gate.detail, /no shell tool available/);
    assert.match(gate.detail, /phase TOOLSET/);
  });
  it("persists every attempt's transcript and stays never-fatal when persistence fails", async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const artDir = mkdtempSync(join(tmpdir(), "zpr-probe-test-"));
    try {
      const logs = [];
      const persistingRun = async (command, args, opts) => ({ code: 0, stdout: "refused\n", stderr: "" });
      const gate = await gateZcodeHeadless({
        run: persistingRun, zcode: "node", repoRoot,
        artDir, persist: (input) => { const out = persistPhaseOutput(input); if (out.file) logs.push(out.file); return out; },
        log: () => {},
      });
      assert.equal(gate.ok, false);
      assert.equal(logs.length, 3, "one transcript per attempt");
      assert.match(readFileSync(logs[0], "utf8"), /# phase probe #1 — /);
      assert.match(readFileSync(logs[0], "utf8"), /--- stdout ---\nrefused/);
      // Persistence failure (artDir under a regular FILE → mkdir ENOTDIR) must
      // never fail the gate itself: it still runs all attempts and reports.
      const blocker = join(tmpdir(), `zpr-probe-blocker-${Date.now()}`);
      writeFileSync(blocker, "x");
      const logsBroken = [];
      let brokenCalls = 0;
      const gate2 = await gateZcodeHeadless({
        run: async (command, args, opts) => { brokenCalls += 1; return { code: 0, stdout: `${opts.env.ZPR_PROBE_TOKEN}\n`, stderr: "" }; },
        zcode: "node", repoRoot, artDir: join(blocker, ".dev-loop"),
        persist: (input) => { const out = persistPhaseOutput(input); if (out.error) logsBroken.push(out.error); return out; },
        log: () => {},
      });
      assert.equal(gate2.ok, true, "a passing attempt still passes with persistence broken");
      assert.ok(logsBroken.length >= 1, "the persistence error was disclosed, not thrown");
    } finally {
      rmSync(artDir, { recursive: true, force: true });
    }
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

describe("mergeabilityGate", () => {
  const pr = { number: 18, headRefName: "i4-topologies-tiers" };
  it("fails CONFLICTING early, before a review cycle can burn on an unmergeable head", () => {
    const gate = mergeabilityGate({ ...pr, mergeable: "CONFLICTING" });
    assert.equal(gate.ok, false);
    assert.equal(gate.name, "mergeable");
    assert.match(gate.detail, /CONFLICTING.*merge main into i4-topologies-tiers/);
  });
  it("passes MERGEABLE, UNKNOWN (gh computes it async), and missing state — the pre-merge pin stays the backstop", () => {
    for (const mergeable of ["MERGEABLE", "UNKNOWN", undefined, null]) {
      const gate = mergeabilityGate({ ...pr, mergeable });
      assert.equal(gate.ok, true, `mergeable=${String(mergeable)}`);
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

describe("runPreflightGates", () => {
  const idleOutputs = {
    "git rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n", stderr: "" },
    "git rev-parse main origin/main": { code: 0, stdout: "commit-a\ncommit-a\n", stderr: "" },
    "gh pr list --state open --json number,headRefName": { code: 0, stdout: "[]", stderr: "" },
  };
  const makeRun = (probeResult) => {
    const calls = [];
    const run = async (command, args, opts = {}) => {
      calls.push([command, ...args]);
      if (command === "zcode") return probeResult(opts);
      const key = `${command} ${args.join(" ")}`;
      return idleOutputs[key] ?? { code: 0, stdout: "", stderr: "" };
    };
    return { calls, run };
  };
  it("runs all four gates when the probe passes", async () => {
    const { calls, run } = makeRun((opts) => ({ code: 0, stdout: opts.env.ZPR_PROBE_TOKEN, stderr: "" }));
    const logs = [];
    const results = await runPreflightGates({ run, repoRoot: realRoot, zcode: "zcode", env: {}, log: (l) => logs.push(l) });
    assert.deepEqual(results.map((g) => g.name), ["repo-idle", "zcode-headless", "tests", "smokes"]);
    assert.ok(results.every((g) => g.ok));
    assert.ok(calls.some(([cmd, ...args]) => cmd === "node" && args[0] === "--test"), "tests gate ran");
    assert.ok(calls.some(([cmd, ...args]) => cmd === "node" && args[0]?.startsWith("tests/smoke-")), "smokes gate ran");
    assert.equal(logs.length, 4);
    assert.match(logs[1], /^gate zcode-headless: PASS /);
  });
  it("short-circuits on a failed probe: tests and smokes never run", async () => {
    const { calls, run } = makeRun(() => ({ code: 0, stdout: "I don't have a shell tool available in this session", stderr: "" }));
    const logs = [];
    const results = await runPreflightGates({ run, repoRoot: realRoot, zcode: "zcode", env: {}, log: (l) => logs.push(l) });
    assert.deepEqual(results.map((g) => g.name), ["repo-idle", "zcode-headless"]);
    assert.equal(results[1].ok, false);
    assert.ok(!calls.some(([cmd]) => cmd === "node"), "no test/smoke execution after a failed probe");
    assert.match(logs[1], /^gate zcode-headless: FAIL /);
  });
});
