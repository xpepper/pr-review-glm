// tests/dev-loop-loop.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewBlocking, runLoop } from "../scripts/dev-loop/loop.mjs";

const gate = (name, ok = true, detail = "") => ({ name, ok, detail });
const review = (verdict, findings = []) => ({ verdict, findings });
const cleanRun = { code: 0, timedOut: false };
const p01 = [{ severity: "P1", title: "bug" }];

function deps(overrides = {}) {
  const calls = { worker: 0, reviewer: 0, dogfood: 0, fixer: 0, merge: 0, sleeps: [] };
  const base = {
    readStatus: async () => ({ kind: "next", increment: "I3" }),
    preflight: async () => [gate("idle")],
    runWorker: async () => { calls.worker++; return cleanRun; },
    workerGates: async () => ({ results: [gate("pr", true, "PR #7")], prNumber: 7 }),
    runReviewer: async () => { calls.reviewer++; return { ...cleanRun, review: review("approve") }; },
    runDogfood: async () => { calls.dogfood++; return { ...cleanRun, review: review("approve") }; },
    runFixer: async () => { calls.fixer++; return cleanRun; },
    merge: async () => { calls.merge++; return { code: 0, stderr: "" }; },
    postMergeGates: async () => [gate("main-green")],
    sleep: async (ms) => calls.sleeps.push(ms),
    log: () => {},
  };
  return { deps: { ...base, ...overrides }, calls };
}

describe("reviewBlocking", () => {
  it("treats malformed reviews and unknown verdicts as fatal", () => {
    assert.equal(reviewBlocking(null).fatal, "review result missing or malformed");
    assert.match(reviewBlocking({ verdict: "meh", findings: [] }).fatal, /unknown verdict/);
  });
  it("blocks on request-changes or P0/P1; approve and nits pass", () => {
    assert.equal(reviewBlocking(review("request-changes")).blocking, true);
    assert.equal(reviewBlocking(review("approve", p01)).blocking, true);
    assert.equal(reviewBlocking(review("approve-with-nits", [{ severity: "P2", title: "nit" }])).blocking, false);
  });
});

describe("runLoop", () => {
  it("stops at done/blocked/invalid status without dispatching anything", async () => {
    for (const status of [{ kind: "done" }, { kind: "blocked", reason: "x" }, { kind: "missing" }]) {
      const { deps: d } = deps({ readStatus: async () => status });
      const summary = await runLoop(d);
      assert.notEqual(summary.stopped, "completed");
      assert.equal(summary.iterations.length, 0);
    }
  });
  it("stops before the worker when preflight fails", async () => {
    const { deps: d, calls } = deps({ preflight: async () => [gate("idle", false, "dirty")] });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.equal(calls.worker, 0);
  });
  it("stops when the worker invocation fails", async () => {
    const { deps: d, calls } = deps({ runWorker: async () => ({ code: 1, timedOut: false }) });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.equal(calls.reviewer, 0);
  });
  it("with dogfood off: stops at awaiting-human-merge without merging", async () => {
    const { deps: d, calls } = deps();
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "awaiting-human-merge");
    assert.equal(calls.merge, 0);
    assert.equal(summary.iterations[0].prNumber, 7);
  });
  it("with dogfood on: merges after both reviews clean, runs post-merge gates", async () => {
    const { deps: d, calls } = deps({ dogfood: true });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "completed");
    assert.equal(calls.merge, 1);
    assert.equal(calls.dogfood, 1);
    assert.equal(summary.iterations[0].merged, true);
  });
  it("routes blocking findings to the fixer, then re-assesses", async () => {
    let reviews = 0;
    const { deps: d, calls } = deps({
      dogfood: true,
      runReviewer: async () => { reviews++; return { ...cleanRun, review: reviews === 1 ? review("approve", p01) : review("approve") }; },
    });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "completed");
    assert.equal(calls.fixer, 1);
    assert.equal(summary.iterations[0].fixerRounds, 1);
  });
  it("stops after exhausting the fixer budget", async () => {
    const { deps: d, calls } = deps({
      runReviewer: async () => ({ ...cleanRun, review: review("request-changes", p01) }),
    });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.equal(calls.fixer, 2);
  });
  it("treats a crashed reviewer as fatal, not fixable", async () => {
    const { deps: d, calls } = deps({ runReviewer: async () => ({ code: 1, timedOut: false, review: undefined }) });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.equal(calls.fixer, 0);
  });
  it("stops when main is red after merge", async () => {
    const { deps: d } = deps({ dogfood: true, postMergeGates: async () => [gate("main-green", false, "tests failed")] });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.match(summary.reason, /main-green/);
  });
  it("cools down between iterations and stops with completed", async () => {
    const { deps: d, calls } = deps({ dogfood: true, maxIterations: 2 });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "completed");
    assert.equal(summary.iterations.length, 2);
    assert.deepEqual(calls.sleeps, [60_000]);
  });
});
