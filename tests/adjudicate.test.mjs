// tests/adjudicate.test.mjs — I5 unit tests: diff-anchor parsing, host-side
// candidate validation, dedup, the per-mode findings policy, the adjudicator
// prompt, adjudicated-output re-validation, and the full assembly (including
// degraded paths) against a fake SDK runtime (no real model calls).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adjudicatedProblem,
  applyModePolicy,
  assembleReview,
  buildAdjudicatorPrompt,
  candidateProblem,
  dedupFindings,
  parseDiffAnchors,
} from "../extensions/z-pr-review/adjudicate.mjs";
import { REVIEW_ENVELOPE_BEGIN, REVIEW_ENVELOPE_END } from "../extensions/z-pr-review/lane.mjs";

const DIFF = [
  "diff --git a/src/a.mjs b/src/a.mjs",
  "index 111..222 100644",
  "--- a/src/a.mjs",
  "+++ b/src/a.mjs",
  "@@ -1,3 +1,4 @@",
  " line1",
  "+line2",
  " line3",
  "+line4",
  "@@ -10,2 +11,1 @@",
  " context",
  "-removed",
  "diff --git a/src/gone.mjs b/src/gone.mjs",
  "deleted file mode 100644",
  "--- a/src/gone.mjs",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-old1",
  "-old2",
].join("\n");

const ENVELOPE = {
  kind: "z-pr-review-capture",
  schemaVersion: 1,
  repo: "xpepper/pr-review-glm",
  pr: { number: 31, title: "I5", base: { refName: "main" }, head: { refName: "i5" } },
  diff: DIFF,
};

const config = {
  tiers: { light: { model: null, effort: "low" }, medium: { model: null, effort: "medium" }, heavy: { model: null, effort: "high" } },
  deadlines: { attemptMs: { light: 60_000, medium: 60_000, heavy: 60_000 }, fallbackMs: 60_000, batchMs: 120_000, adjudicationMs: 60_000, totalMs: 180_000 },
};

// Same fake-runtime pattern as tests/lane.test.mjs (extend, don't fork, applies
// to the SDK harness; this is the plain-lane fake re-declared locally so the
// adjudicate suite stays standalone like the lane suite).
function fakeRuntime(script, captured = {}) {
  const listeners = [];
  const session = {
    send: async ({ prompt }) => {
      captured.prompt = prompt;
      for (const step of script) await step({ emit: (event) => listeners.forEach((fn) => fn(event)), session });
    },
    abort: async () => {},
    on: (fn) => {
      listeners.push(fn);
      return () => listeners.splice(listeners.indexOf(fn), 1);
    },
  };
  const client = { stop: async () => [] };
  return {
    captured,
    createRuntime: async (runtimeConfig) => {
      Object.assign(captured, runtimeConfig);
      return { client, session };
    },
  };
}

function envelopeText(findings) {
  return `${REVIEW_ENVELOPE_BEGIN}\n${JSON.stringify(findings, null, 2)}\n${REVIEW_ENVELOPE_END}`;
}

function laneResult(laneId, tier, findings, dropped = []) {
  return { laneId, tier, status: "complete", findings, dropped, attempts: [{ model: null, label: "primary", status: "complete" }] };
}

describe("parseDiffAnchors", () => {
  it("records touched files and new-side hunk ranges", () => {
    const anchors = parseDiffAnchors(DIFF);
    assert.ok(anchors.touched.has("src/a.mjs"));
    assert.ok(anchors.touched.has("src/gone.mjs"), "the pre-image path of a deletion is touched");
    const a = anchors.files.get("src/a.mjs");
    assert.deepEqual(a.ranges, [[1, 4], [11, 11]]);
    assert.equal(a.newSide, true);
    const gone = anchors.files.get("src/gone.mjs");
    assert.equal(gone.newSide, false, "+++ /dev/null leaves no new-file side");
    assert.deepEqual(gone.ranges, []);
  });
  it("accepts a hunk with an omitted count (single-line range) and resets ranges at file boundaries", () => {
    const anchors = parseDiffAnchors(
      [
        "diff --git a/x.mjs b/x.mjs",
        "--- a/x.mjs",
        "+++ b/x.mjs",
        "@@ -5 +7 @@",
        "+only",
        "diff --git a/y.mjs b/y.mjs",
        "--- a/y.mjs",
        "+++ b/y.mjs",
        "@@ -1 +1 @@",
        "+h",
      ].join("\n"),
    );
    assert.deepEqual(anchors.files.get("x.mjs").ranges, [[7, 7]], "omitted count means one new-side line");
    assert.deepEqual(anchors.files.get("y.mjs").ranges, [[1, 1]], "ranges do not leak across the diff --git boundary");
  });
});

describe("candidateProblem (host validation)", () => {
  const anchors = parseDiffAnchors(DIFF);
  it("accepts an in-hunk anchor, a file-only anchor, and a file-less finding", () => {
    assert.equal(candidateProblem({ severity: "P2", title: "t", file: "src/a.mjs", line: 2, detail: "d" }, anchors), null);
    assert.equal(candidateProblem({ severity: "P3", title: "t", file: "src/a.mjs" }, anchors), null);
    assert.equal(candidateProblem({ severity: "nit", title: "t" }, anchors), null);
  });
  it("rejects files the diff does not touch and lines outside its hunks", () => {
    assert.match(candidateProblem({ severity: "P2", title: "t", file: "elsewhere.mjs", line: 1 }, anchors), /not touched by the diff/);
    assert.match(candidateProblem({ severity: "P2", title: "t", file: "src/a.mjs", line: 9 }, anchors), /outside the changed hunks/);
    assert.match(candidateProblem({ severity: "P2", title: "t", file: "src/gone.mjs", line: 1 }, anchors), /no new-file side/);
  });
  it("normalizes a/ and b/ prefixes on both sides", () => {
    assert.equal(candidateProblem({ severity: "P2", title: "t", file: "b/src/a.mjs", line: 3 }, anchors), null);
    assert.equal(candidateProblem({ severity: "P2", title: "t", file: "a/src/a.mjs", line: 3 }, anchors), null);
  });
  it("requires evidence (detail) for blocking severities", () => {
    assert.match(candidateProblem({ severity: "P1", title: "t", file: "src/a.mjs", line: 2 }, anchors), /P1 finding carries no evidence/);
    assert.equal(candidateProblem({ severity: "P1", title: "t", file: "src/a.mjs", line: 2, detail: "quote" }, anchors), null);
  });
});

describe("dedupFindings", () => {
  it("merges file+line+title duplicates and unions their lanes", () => {
    const merged = dedupFindings([
      { severity: "P2", title: "Same Bug ", file: "a.mjs", line: 3, lanes: ["correctness"] },
      { severity: "P2", title: "same bug", file: "a.mjs", line: 3, lanes: ["security-performance"] },
      { severity: "P2", title: "same bug", file: "a.mjs", line: 4, lanes: ["overview"] },
    ]);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged[0].lanes, ["correctness", "security-performance"]);
  });
});

describe("applyModePolicy (code-owned, per mode)", () => {
  const findings = [
    { severity: "P1", title: "a", file: "a.mjs", line: 1 },
    { severity: "P3", title: "b", file: "a.mjs", line: 2 },
    { severity: "nit", title: "c", file: "a.mjs", line: 3 },
    { severity: "nit", title: "d", file: "a.mjs", line: 4 },
    { severity: "nit", title: "e", file: "a.mjs", line: 5 },
    { severity: "nit", title: "unanchored" },
  ];
  it("quick keeps P0–P2 only", () => {
    const { kept, dropped } = applyModePolicy("quick", findings);
    assert.deepEqual(kept.map((f) => f.title), ["a"]);
    assert.equal(dropped.length, 5);
  });
  it("balanced keeps P0–P2 plus at most three anchored P3/nit", () => {
    const { kept } = applyModePolicy("balanced", findings);
    assert.deepEqual(kept.map((f) => f.title), ["a", "b", "c", "d"], "the unanchored nit and the 4th anchored one drop");
  });
  it("full, deep, and custom modes keep everything", () => {
    for (const mode of ["full", "deep", "my-custom"]) {
      assert.deepEqual(applyModePolicy(mode, findings).kept.map((f) => f.title), findings.map((f) => f.title), mode);
    }
  });
});

describe("adjudicatedProblem (adjudicator output re-validation)", () => {
  const anchors = parseDiffAnchors(DIFF);
  it("applies the ladder, sources shape, and the same anchor/evidence checks", () => {
    assert.match(adjudicatedProblem({ severity: "P9", title: "t" }, anchors), /not on the ladder/);
    assert.match(adjudicatedProblem({ severity: "P2", title: "t", sources: "correctness" }, anchors), /sources is not an array/);
    assert.match(adjudicatedProblem({ severity: "P2", title: "t", file: "nope.mjs", line: 1 }, anchors), /not touched by the diff/);
    assert.equal(adjudicatedProblem({ severity: "P2", title: "t", file: "src/a.mjs", line: 2, sources: ["correctness"] }, anchors), null);
  });
});

describe("buildAdjudicatorPrompt", () => {
  it("carries the candidates, the diff, and the envelope output contract", () => {
    const candidates = [{ severity: "P2", title: "t", file: "src/a.mjs", line: 2, lanes: ["correctness"] }];
    const prompt = buildAdjudicatorPrompt(ENVELOPE, candidates);
    assert.match(prompt, /adjudicator/);
    assert.match(prompt, /"sources"/);
    assert.ok(prompt.includes(JSON.stringify(candidates, null, 2)));
    assert.ok(prompt.includes(DIFF));
    assert.match(prompt, new RegExp(REVIEW_ENVELOPE_BEGIN));
    assert.match(prompt, new RegExp(REVIEW_ENVELOPE_END));
  });
});

describe("assembleReview", () => {
  const batch = (lanes) => ({
    mode: "balanced",
    lanes,
    elapsedMs: 5_000,
    status: lanes.every((lane) => lane.status === "complete") ? "complete" : "partial",
    ...(lanes.every((lane) => lane.status === "complete") ? {} : { reason: "1 of 2 lanes failed: correctness (deadline exceeded after 1ms)" }),
  });
  const candidate = { severity: "P2", title: "race on close", file: "src/a.mjs", line: 2, detail: "+line2 closes twice" };

  it("runs the adjudicator over validated candidates and reports merged findings", async () => {
    const { createRuntime, captured } = fakeRuntime([
      async ({ emit }) => {
        emit({
          type: "assistant.message",
          data: {
            content: envelopeText([
              { severity: "P2", title: "race on close", file: "src/a.mjs", line: 2, detail: "+line2 closes twice", sources: ["correctness"] },
            ]),
          },
        });
        emit({ type: "session.idle" });
      },
    ]);
    const review = await assembleReview({
      batch: batch([laneResult("correctness", "heavy", [candidate])]),
      mode: "balanced",
      envelope: ENVELOPE,
      config,
      repoRoot: process.cwd(),
      adjudicationDeadlineAt: Date.now() + 60_000,
      createRuntime,
    });
    assert.equal(review.status, "complete");
    assert.equal(review.adjudication.status, "complete");
    assert.deepEqual(review.findings, [
      { severity: "P2", title: "race on close", file: "src/a.mjs", line: 2, detail: "+line2 closes twice", lane: "correctness" },
    ]);
    assert.deepEqual(review.drops, { shaping: 0, validation: 0, adjudication: 0, policy: 0 });
    assert.match(captured.prompt, /adjudicator/, "the adjudicator prompt replaces the lane prompt");
  });

  it("drops candidates failing host validation and skips adjudication when nothing survives", async () => {
    const { createRuntime, captured } = fakeRuntime([]);
    const review = await assembleReview({
      batch: batch([laneResult("correctness", "heavy", [{ severity: "P2", title: "ghost", file: "nope.mjs", line: 1 }])]),
      mode: "balanced",
      envelope: ENVELOPE,
      config,
      repoRoot: process.cwd(),
      adjudicationDeadlineAt: Date.now() + 60_000,
      createRuntime,
    });
    assert.equal(review.adjudication.status, "skipped");
    assert.equal(captured.prompt, undefined, "no adjudicator child runs without validated candidates");
    assert.deepEqual(review.findings, []);
    assert.equal(review.drops.validation, 1);
    assert.match(review.validationDrops[0].reason, /not touched by the diff/);
    assert.equal(review.status, "complete", "nothing to adjudicate is still a clean empty review");
  });

  it("degrades to the validated candidates when the adjudicator violates its contract", async () => {
    const { createRuntime } = fakeRuntime([
      async ({ emit }) => {
        emit({ type: "assistant.message", data: { content: "no markers at all" } });
        emit({ type: "session.idle" });
      },
    ]);
    const review = await assembleReview({
      batch: batch([laneResult("correctness", "heavy", [candidate])]),
      mode: "balanced",
      envelope: ENVELOPE,
      config,
      repoRoot: process.cwd(),
      adjudicationDeadlineAt: Date.now() + 60_000,
      createRuntime,
    });
    assert.equal(review.status, "degraded");
    assert.match(review.reason, /adjudication failed: output contract violated/);
    assert.match(review.reason, /unmerged validated candidates/);
    assert.deepEqual(review.findings, [{ ...candidate, lane: "correctness" }]);
    assert.equal(review.adjudication.status, "failed");
  });

  it("re-validates adjudicator output: malformed entries drop, unknown sources strip", async () => {
    const { createRuntime } = fakeRuntime([
      async ({ emit }) => {
        emit({
          type: "assistant.message",
          data: {
            content: envelopeText([
              { severity: "P2", title: "good", file: "src/a.mjs", line: 2, sources: ["correctness", "hallucinated-lane"] },
              { severity: "P2", title: "off-diff", file: "nope.mjs", line: 1, sources: ["correctness"] },
              { severity: "urgent", title: "off-ladder", sources: [] },
            ]),
          },
        });
        emit({ type: "session.idle" });
      },
    ]);
    const review = await assembleReview({
      batch: batch([laneResult("correctness", "heavy", [candidate])]),
      mode: "balanced",
      envelope: ENVELOPE,
      config,
      repoRoot: process.cwd(),
      adjudicationDeadlineAt: Date.now() + 60_000,
      createRuntime,
    });
    assert.equal(review.status, "complete");
    assert.equal(review.drops.adjudication, 2);
    assert.equal(review.findings.length, 1);
    assert.equal(review.findings[0].lane, "correctness", "unknown source ids attribute nothing");
  });

  it("applies the mode policy to the merged findings", async () => {
    const { createRuntime } = fakeRuntime([
      async ({ emit }) => {
        emit({
          type: "assistant.message",
          data: {
            content: envelopeText([
              { severity: "P3", title: "hygiene", file: "src/a.mjs", line: 2, sources: ["overview"] },
            ]),
          },
        });
        emit({ type: "session.idle" });
      },
    ]);
    const review = await assembleReview({
      batch: batch([laneResult("overview", "light", [{ severity: "P3", title: "hygiene", file: "src/a.mjs", line: 2 }])]),
      mode: "quick",
      envelope: ENVELOPE,
      config,
      repoRoot: process.cwd(),
      adjudicationDeadlineAt: Date.now() + 60_000,
      createRuntime,
    });
    assert.deepEqual(review.findings, [], "quick mode drops P3 even after adjudication");
    assert.equal(review.drops.policy, 1);
  });

  it("assembles completed lanes' findings on a partial batch, disclosed as partial", async () => {
    const { createRuntime } = fakeRuntime([
      async ({ emit }) => {
        emit({ type: "assistant.message", data: { content: envelopeText([{ severity: "P2", title: "race on close", file: "src/a.mjs", line: 2, sources: ["correctness"] }]) } });
        emit({ type: "session.idle" });
      },
    ]);
    const failed = { laneId: "overview", tier: "light", status: "failed", reason: "deadline exceeded after 1ms", findings: [], dropped: [] };
    const review = await assembleReview({
      batch: batch([laneResult("correctness", "heavy", [candidate]), failed]),
      mode: "balanced",
      envelope: ENVELOPE,
      config,
      repoRoot: process.cwd(),
      adjudicationDeadlineAt: Date.now() + 60_000,
      createRuntime,
    });
    assert.equal(review.status, "partial");
    assert.match(review.reason, /1 of 2 lanes failed/);
    assert.equal(review.findings.length, 1, "completed lanes' artifacts still flow to synthesis");
  });

  it("fails the adjudication closed when the budget expired before it could run", async () => {
    const { createRuntime, captured } = fakeRuntime([]);
    const review = await assembleReview({
      batch: batch([laneResult("correctness", "heavy", [candidate])]),
      mode: "balanced",
      envelope: ENVELOPE,
      config,
      repoRoot: process.cwd(),
      adjudicationDeadlineAt: Date.now() - 1,
      createRuntime,
    });
    assert.equal(review.status, "degraded");
    assert.equal(review.adjudication.status, "failed");
    assert.match(review.adjudication.reason, /budget expired before adjudication/);
    assert.equal(captured.prompt, undefined, "no adjudicator child is dispatched past the budget");
    assert.equal(review.findings.length, 1, "validated candidates still flow, degraded");
  });
});
