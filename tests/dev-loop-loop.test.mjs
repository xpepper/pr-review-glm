// tests/dev-loop-loop.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewBlocking, runLoop } from "../scripts/dev-loop/loop.mjs";

const gate = (name, ok = true, detail = "") => ({ name, ok, detail });
const review = (verdict, findings = []) => ({ verdict, findings });
const cleanRun = { code: 0, timedOut: false };
const p01 = [{ severity: "P1", title: "bug" }];
const oid = (char) => char.repeat(40); // full 40-hex SHAs, as gh reports headRefOid
const HEAD_A = oid("a");
const HEAD_B = oid("b");
const HEAD_C = oid("c");

function deps(overrides = {}) {
  const calls = { worker: 0, reviewer: 0, dogfood: 0, fixer: 0, merge: 0, postMerge: 0, assessments: 0, mergedPr: null, mergeHeads: [], sleeps: [] };
  const base = {
    readStatus: async () => ({ kind: "next", increment: "I3" }),
    preflight: async () => [gate("idle")],
    runWorker: async () => { calls.worker++; return cleanRun; },
    workerGates: async () => {
      calls.assessments++;
      return { results: [gate("pr", true, "PR #7")], prNumber: 7, headRefOid: HEAD_A };
    },
    runReviewer: async () => { calls.reviewer++; return { ...cleanRun, review: review("approve") }; },
    runDogfood: async () => { calls.dogfood++; return { ...cleanRun, review: review("approve") }; },
    runFixer: async () => { calls.fixer++; return cleanRun; },
    fetchPrHead: async () => ({ headRefOid: HEAD_A }),
    merge: async (prNumber, expectedHeadRefOid) => { calls.merge++; calls.mergedPr = prNumber; calls.mergeHeads.push(expectedHeadRefOid); return { code: 0, stderr: "" }; },
    postMergeGates: async () => { calls.postMerge++; return [gate("main-green")]; },
    sleep: async (ms) => calls.sleeps.push(ms),
    log: () => {},
  };
  // Since I3, --merge auto requires the dogfood review; tests that opt into
  // auto without saying otherwise run with it on (the one refusal test below
  // passes dogfood:false explicitly).
  if (overrides.mergeMode === "auto" && overrides.dogfood === undefined) {
    overrides = { ...overrides, dogfood: true };
  }
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
});

describe("runLoop merge modes (L2)", () => {
  it("human (default): stops at awaiting-human-merge without merging", async () => {
    const { deps: d, calls } = deps();
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "awaiting-human-merge");
    assert.equal(calls.merge, 0);
    assert.equal(summary.iterations[0].prNumber, 7);
  });
  it("human with dogfood on: reviews still run, merging stays human's", async () => {
    const { deps: d, calls } = deps({ dogfood: true });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "awaiting-human-merge");
    assert.equal(calls.dogfood, 1);
    assert.equal(calls.merge, 0);
  });
  it("auto with dogfood off (pre-I3 behavior, now refused): stops before dispatching anything", async () => {
    const { deps: d, calls } = deps({ mergeMode: "auto", dogfood: false });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.match(summary.reason, /requires --dogfood on/);
    assert.equal(calls.worker, 0, "nothing must be dispatched");
  });
  it("dogfood on without a dogfood runner wired: fails closed", async () => {
    const { deps: d, calls } = deps({ dogfood: true });
    delete d.runDogfood;
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.match(summary.reason, /not wired/);
    assert.equal(calls.worker, 0);
  });
  it("auto with dogfood on: requires both reviews clean, then merges", async () => {
    const { deps: d, calls } = deps({ mergeMode: "auto", dogfood: true });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "completed");
    assert.equal(calls.merge, 1);
    assert.equal(calls.dogfood, 1);
    assert.deepEqual(calls.mergeHeads, [HEAD_A], "the merge must be pinned to the reviewed head OID");
    assert.equal(summary.iterations[0].merged, true);
  });
  it("auto: never merges on blocking findings — fixer runs, budget exhaustion stops it", async () => {
    const { deps: d, calls } = deps({
      mergeMode: "auto",
      runReviewer: async () => ({ ...cleanRun, review: review("request-changes", p01) }),
    });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.match(summary.reason, /fixer budget/);
    assert.equal(calls.fixer, 2);
    assert.equal(calls.merge, 0);
  });
  it("auto: a crashed reviewer is fatal and never merges", async () => {
    const { deps: d, calls } = deps({ mergeMode: "auto", runReviewer: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, review: undefined }) });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.equal(calls.fixer, 0);
    assert.equal(calls.merge, 0);
  });
  it("fatal review invocations carry the invocation's first error line in the reason", async () => {
    const { deps: d, calls } = deps({
      mergeMode: "auto",
      runReviewer: async () => ({
        code: 1, stdout: "",
        stderr: "Error: Timed out waiting for plugin commands; registered: z-pr-review (unexpected description)\n    at somewhere",
        timedOut: false, review: undefined,
      }),
    });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.match(summary.reason, /review invocation failed \(code=1, timedOut=false\): Error: Timed out waiting for plugin commands/);
    assert.equal(calls.merge, 0);
  });
  it("auto: gate blocking with no known PR fails fast instead of dispatching the fixer", async () => {
    const { deps: d, calls } = deps({
      mergeMode: "auto",
      workerGates: async () => ({ results: [gate("increment-pr", false, "expected exactly one open PR, found 0")], prNumber: null }),
    });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.equal(calls.fixer, 0);
    assert.equal(calls.merge, 0);
    assert.match(summary.reason, /no known PR/);
  });
});

describe("runLoop head pinning (auto only)", () => {
  it("re-enters assessment when the head moved, then merges the re-assessed stable head", async () => {
    const heads = [HEAD_A, HEAD_B];
    const { deps: d, calls } = deps({
      mergeMode: "auto",
      workerGates: async () => {
        const headRefOid = heads[Math.min(calls.assessments, heads.length - 1)];
        calls.assessments++;
        return { results: [gate("pr", true, "PR #7")], prNumber: 7, headRefOid };
      },
      fetchPrHead: async () => ({ headRefOid: HEAD_B }),
    });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "completed");
    assert.equal(calls.merge, 1);
    assert.equal(calls.mergedPr, 7);
    assert.deepEqual(calls.mergeHeads, [HEAD_B], "after re-assessment the merge pins the re-reviewed head");
    assert.equal(calls.reviewer, 2); // the moved head was fully re-reviewed, not trusted
    assert.equal(calls.assessments, 2);
    assert.equal(summary.iterations[0].merged, true);
  });
  it("never merges when the head moves again after re-assessment", async () => {
    const heads = [HEAD_A, HEAD_B];
    const remoteHeads = [HEAD_B, HEAD_C];
    let fetches = 0;
    const { deps: d, calls } = deps({
      mergeMode: "auto",
      workerGates: async () => {
        const headRefOid = heads[Math.min(calls.assessments, heads.length - 1)];
        calls.assessments++;
        return { results: [gate("pr", true, "PR #7")], prNumber: 7, headRefOid };
      },
      fetchPrHead: async () => ({ headRefOid: remoteHeads[Math.min(fetches++, remoteHeads.length - 1)] }),
    });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.match(summary.reason, /moved again/);
    assert.equal(calls.merge, 0);
    assert.equal(calls.reviewer, 2);
  });
  it("refuses to merge when the assessed head is unknown", async () => {
    const { deps: d, calls } = deps({
      mergeMode: "auto",
      workerGates: async () => ({ results: [gate("pr", true, "PR #7")], prNumber: 7, headRefOid: undefined }),
    });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.match(summary.reason, /unknown head/);
    assert.equal(calls.merge, 0);
  });
  it("refuses to merge when the pre-merge head re-fetch fails", async () => {
    const { deps: d, calls } = deps({
      mergeMode: "auto",
      fetchPrHead: async () => ({ error: "gh pr view failed (exit 1)" }),
    });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.match(summary.reason, /gh pr view failed/);
    assert.equal(calls.merge, 0);
  });
  it("fails closed when fetchPrHead is not wired at all", async () => {
    const { deps: d, calls } = deps({ mergeMode: "auto" });
    delete d.fetchPrHead;
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.equal(calls.merge, 0);
  });
  it("logs (not swallows) a merge-path warning/note returned on a successful merge (round-5 P2)", async () => {
    const lines = [];
    const { deps: d, calls } = deps({
      mergeMode: "auto",
      merge: async (prNumber, expectedHeadRefOid) => {
        calls.merge++; calls.mergedPr = prNumber; calls.mergeHeads.push(expectedHeadRefOid);
        return { code: 0, stderr: "", warning: "remote branch i3-x was not deleted (delete it manually): rejected", note: "branch lives in the PR author's fork" };
      },
      log: (line) => lines.push(line),
    });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "completed", "a warning on a successful merge must not fail the iteration");
    assert.ok(lines.some((line) => /warning:.*not deleted/.test(line)), "the deletion warning is disclosed in the log");
    assert.ok(lines.some((line) => /note:.*fork/.test(line)), "the fork note is disclosed in the log");
  });
});

describe("runLoop mid-iteration resume", () => {
  it("adopts a resumable PR: no preflight, no worker dispatch, assessment proceeds to merge", async () => {
    let preflights = 0;
    const { deps: d, calls } = deps({
      mergeMode: "auto",
      findResumablePr: async () => ({ prNumber: 18, headRefName: "i4-topologies-tiers" }),
      preflight: async () => { preflights++; return [gate("idle")]; },
      workerGates: async () => {
        calls.assessments++;
        return { results: [gate("pr", true, "PR #18")], prNumber: 18, headRefOid: HEAD_A };
      },
    });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "completed");
    assert.equal(preflights, 0);
    assert.equal(calls.worker, 0);
    assert.equal(calls.reviewer, 1);
    assert.equal(calls.dogfood, 1);
    assert.equal(calls.merge, 1);
    assert.equal(calls.mergedPr, 18);
    assert.equal(summary.iterations[0].adopted, true);
    assert.equal(summary.iterations[0].merged, true);
  });
  it("probe returns null: normal path with preflight and worker", async () => {
    let preflights = 0;
    const { deps: d, calls } = deps({
      findResumablePr: async () => null,
      preflight: async () => { preflights++; return [gate("idle")]; },
    });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "awaiting-human-merge");
    assert.equal(preflights, 1);
    assert.equal(calls.worker, 1);
    assert.equal(summary.iterations[0].adopted, undefined);
  });
  it("adoption keeps the protective fail-stop: blocking gates with no PR number never dispatch a fixer", async () => {
    const { deps: d, calls } = deps({
      mergeMode: "auto",
      findResumablePr: async () => ({ prNumber: 18, headRefName: "i4-x" }),
      workerGates: async () => ({ results: [gate("docs-updated", false, "HANDOFF STATUS is invalid")], prNumber: null }),
    });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.match(summary.reason, /no known PR/);
    assert.equal(calls.worker, 0);
    assert.equal(calls.fixer, 0);
    assert.equal(calls.merge, 0);
  });
});

describe("runLoop phase-timing capture (post-I4 calibration)", () => {
  it("records one duration per dispatch on the iteration, including repeats across assessments", async () => {
    let reviews = 0;
    const { deps: d } = deps({
      mergeMode: "auto",
      runReviewer: async () => { reviews++; return { ...cleanRun, review: reviews === 1 ? review("approve", p01) : review("approve") }; },
    });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "completed");
    const timings = summary.iterations[0].phaseTimings;
    assert.deepEqual(Object.keys(timings).sort(), ["dogfood", "fixer", "gates", "merge", "reviewer", "worker"]);
    assert.equal(timings.worker.length, 1);
    assert.equal(timings.gates.length, 2, "re-assessed after the fixer round");
    assert.equal(timings.reviewer.length, 2);
    assert.equal(timings.dogfood.length, 2);
    assert.equal(timings.fixer.length, 1);
    assert.equal(timings.merge.length, 1);
    for (const runs of Object.values(timings)) {
      for (const ms of runs) assert.ok(Number.isFinite(ms) && ms >= 0, "durations are non-negative milliseconds");
    }
  });
});

describe("runLoop fixer and iteration flow", () => {
  it("routes blocking findings to the fixer, then re-assesses", async () => {
    let reviews = 0;
    const { deps: d, calls } = deps({
      mergeMode: "auto",
      runReviewer: async () => { reviews++; return { ...cleanRun, review: reviews === 1 ? review("approve", p01) : review("approve") }; },
    });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "completed");
    assert.equal(calls.fixer, 1);
    assert.equal(summary.iterations[0].fixerRounds, 1);
    assert.equal(summary.iterations[0].merged, true);
  });
  it("stops when main is red after merge", async () => {
    const { deps: d } = deps({ mergeMode: "auto", postMergeGates: async () => [gate("main-green", false, "tests failed")] });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "failure");
    assert.match(summary.reason, /main-green/);
  });
  it("cools down between iterations and stops with completed", async () => {
    const { deps: d, calls } = deps({ mergeMode: "auto", maxIterations: 2 });
    const summary = await runLoop(d);
    assert.equal(summary.stopped, "completed");
    assert.equal(summary.iterations.length, 2);
    assert.deepEqual(calls.sleeps, [60_000]);
  });
});
