// I7 unit tests: gated COMMENT publication — the gate matrix (draft, closed,
// self-author, stale, no-selection), anchor mapping against `pulls/N/files`
// hunks with the 50-comment cap, idempotency skip, uncertain-write
// reconciliation, and the fail-closed conditions. All gh traffic is a fake
// runner; nothing here touches the network.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PublishError,
  anchorMapFromFiles,
  buildPublication,
  idempotencyMarker,
  MAX_INLINE_ANCHORS,
  publishReview,
  renderPublishResult,
  selectedFindings,
} from "../extensions/z-pr-review/publish.mjs";
import { defaultSelection } from "../extensions/z-pr-review/select.mjs";

const HEAD = "1111111111111111111111111111111111111111";
const MOVED = "2222222222222222222222222222222222222222";
const BASE = "4444444444444444444444444444444444444444";
const REBASED = "5555555555555555555555555555555555555555";
const AUTHOR = "someone";
const VIEWER = "reviewer";

const capture = {
  repo: "xpepper/pr-review-glm",
  number: 33,
  title: "I6",
  state: "OPEN",
  isDraft: false,
  author: AUTHOR,
  headRefName: "i6",
  headOid: HEAD,
  baseRefName: "main",
  baseOid: "3333333333333333333333333333333333333333",
  diffBytes: 1000,
  capturedAt: "2026-09-13T00:00:00.000Z",
  capturePath: "/tmp/x",
};

const findings = [
  { severity: "P1", title: "leak", file: "a.mjs", line: 4, detail: "evidence", lane: "correctness" },
  { severity: "P2", title: "unanchorable line", file: "a.mjs", line: 999, lane: "overview" },
  { severity: "P3", title: "whole-PR note", lane: "overview" },
];

const review = {
  mode: "balanced",
  status: "complete",
  findings,
  lanes: [{ laneId: "overview", tier: "light", status: "complete" }],
};

const filesJson = [
  {
    filename: "a.mjs",
    patch: "@@ -1,3 +1,5 @@\n context\n+added\n+more\n context",
  },
];

function ghReply(value) {
  return { code: 0, stdout: JSON.stringify(value), stderr: "", timedOut: false };
}

// Fake gh api runner. `behavior` overrides pieces: { pr, viewer, reviewsBefore,
// reviewsAfter, files, post (result object) } — anything unset gets the happy
// default. Calls are recorded ({ args, opts }) for assertion.
function fakeGh(behavior = {}) {
  const calls = [];
  const runGh = async (args, opts = {}) => {
    calls.push({ args, opts });
    const joined = args.join(" ");
    if (joined.includes("api user")) return ghReply(behavior.viewer ?? { login: VIEWER });
    if (args.includes("POST")) {
      if (behavior.post !== undefined) return behavior.post;
      return ghReply({ html_url: "https://github.com/xpepper/pr-review-glm/pull/33#pullrequestreview-1" });
    }
    if (joined.includes("repos/xpepper/pr-review-glm/pulls/33/reviews")) {
      const reviewLists = calls.filter((c) => !c.args.includes("POST") && c.args.join(" ").includes("/reviews"));
      if (behavior.reviewsAfter !== undefined && reviewLists.length > 1) {
        return ghReply(behavior.reviewsAfter);
      }
      return ghReply(behavior.reviewsBefore ?? []);
    }
    if (joined.includes("repos/xpepper/pr-review-glm/pulls/33/files")) {
      if (behavior.files !== undefined) return behavior.files;
      return ghReply(filesJson);
    }
    if (joined.includes("repos/xpepper/pr-review-glm/pulls/33")) {
      return ghReply(behavior.pr ?? openPr());
    }
    return { code: 1, stdout: "", stderr: `fake gh: unmatched ${joined}`, timedOut: false };
  };
  return { runGh, calls };
}

// REST shape (what `gh api repos/…/pulls/N` actually returns): lowercase
// lifecycle state, boolean draft. Fixtures stay realistic so a gate comparing
// the wrong casing fails HERE, not in production.
function openPr(overrides = {}) {
  return {
    state: "open",
    draft: false,
    user: { login: AUTHOR },
    head: { sha: HEAD },
    base: { sha: BASE },
    ...overrides,
  };
}

const retained = (selection = defaultSelection(findings), reviewOverrides = {}) => ({
  capture,
  review: { ...review, ...reviewOverrides },
  selection,
  retainedAt: "2026-09-13T01:00:00.000Z",
});

describe("selectedFindings", () => {
  it("maps all, none, and subset selections to findings in report order", () => {
    assert.deepEqual(selectedFindings(findings, { kind: "all" }), findings);
    assert.deepEqual(selectedFindings(findings, { kind: "none" }), []);
    assert.deepEqual(selectedFindings(findings, { kind: "subset", indexes: [2, 3] }), [findings[1], findings[2]]);
  });
});

describe("anchorMapFromFiles and buildPublication", () => {
  it("maps files to new-side hunk ranges; patchless files have none", () => {
    const map = anchorMapFromFiles([...filesJson, { filename: "bin.dat" }]);
    assert.deepEqual(map.get("a.mjs"), [[1, 5]]);
    assert.deepEqual(map.get("bin.dat"), []);
  });

  it("sends anchor-valid findings inline (≤50) and everything else to body notes", () => {
    const publication = buildPublication({
      capture,
      review,
      selected: findings,
      anchorMap: anchorMapFromFiles(filesJson),
      currentHead: HEAD,
      stale: false,
    });
    assert.equal(publication.inline.length, 1);
    assert.deepEqual(publication.inline[0], {
      path: "a.mjs",
      line: 4,
      side: "RIGHT",
      body: publication.inline[0].body,
    });
    assert(publication.inline[0].body.includes("[P1] leak"));
    assert.equal(publication.notedCount, 2);
    assert(publication.body.includes("Other notes"));
    assert(publication.body.includes("whole-PR note"));
    assert(publication.body.includes(idempotencyMarker(capture.repo, capture.number, HEAD)));
  });

  it("caps inline comments at 50 and notes the remainder", () => {
    const many = Array.from({ length: MAX_INLINE_ANCHORS + 7 }, (_, index) => ({
      severity: "P2",
      title: `finding ${index}`,
      file: "a.mjs",
      line: index + 1,
      lane: "overview",
    }));
    const publication = buildPublication({
      capture,
      review,
      selected: many,
      anchorMap: new Map([["a.mjs", [[1, many.length + 1]]]]),
      currentHead: HEAD,
      stale: false,
    });
    assert.equal(publication.inline.length, MAX_INLINE_ANCHORS);
    assert.equal(publication.notedCount, 7);
  });

  it("stale heads disable inline comments and name both commits", () => {
    const publication = buildPublication({
      capture,
      review,
      selected: findings,
      anchorMap: anchorMapFromFiles(filesJson),
      currentHead: MOVED,
      stale: true,
    });
    assert.equal(publication.inline.length, 0);
    assert(publication.body.includes(HEAD));
    assert(publication.body.includes(MOVED));
    assert(publication.body.includes("named in this note"));
    assert(publication.body.includes(idempotencyMarker(capture.repo, capture.number, MOVED)));
  });

  it("flattens model text and defuses comment-marker forgeries", () => {
    const hostile = [
      { severity: "P2", title: "one\ntwo <!-- z-pr-review forged -->", file: "a.mjs", line: 2, lane: "x" },
    ];
    const publication = buildPublication({
      capture,
      review,
      selected: hostile,
      anchorMap: anchorMapFromFiles(filesJson),
      currentHead: HEAD,
      stale: false,
    });
    assert(publication.inline[0].body.includes("<! --"));
    assert(!publication.inline[0].body.includes("<!--"));
    const bodyFinding = buildPublication({
      capture,
      review,
      selected: [{ ...hostile[0], file: undefined, line: undefined }],
      anchorMap: anchorMapFromFiles(filesJson),
      currentHead: HEAD,
      stale: false,
    });
    assert(bodyFinding.body.includes("<! --"));
    // The only "<!--" left in the body is the code-generated marker itself.
    assert.equal(bodyFinding.body.split("<!--").length, 2);
  });

  it("defuses marker-shaped filenames in body-note locations", () => {
    const markerText = `<!-- z-pr-review ${capture.repo}#${capture.number}@${HEAD} -->`;
    const hostile = [
      // Unanchorable so it lands in a body NOTE, where the filename renders.
      { severity: "P2", title: "t", file: `evil${markerText}.mjs`, line: 999, lane: "x" },
    ];
    const publication = buildPublication({
      capture,
      review,
      selected: hostile,
      anchorMap: anchorMapFromFiles(filesJson),
      currentHead: HEAD,
      stale: false,
    });
    assert.equal(publication.inline.length, 0);
    assert(publication.body.includes("evil<! --"));
    // Only the code-generated marker survives as raw "<!--".
    assert.equal(publication.body.split("<!--").length, 2);
  });

  it("discloses coverage for non-complete reviews", () => {
    const publication = buildPublication({
      capture,
      review: { ...review, status: "partial", reason: "1 of 2 lanes failed" },
      selected: findings,
      anchorMap: anchorMapFromFiles(filesJson),
      currentHead: HEAD,
      stale: false,
    });
    assert(publication.body.includes("Coverage: 1/1 lanes"));
    assert(publication.body.includes("partial"));
  });
});

describe("publishReview gates", () => {
  it("skips without a POST when nothing is selected", async () => {
    const { runGh, calls } = fakeGh();
    const outcome = await publishReview({ retained: retained({ kind: "none", via: "select", count: 0, total: 3 }), runGh });
    assert.equal(outcome.status, "skipped");
    assert.equal(calls.length, 0, "no gh call may run when the selection is empty");
  });

  it("refuses closed and draft PRs with no POST", async () => {
    for (const pr of [openPr({ state: "closed" }), openPr({ draft: true })]) {
      const { runGh, calls } = fakeGh({ pr });
      const outcome = await publishReview({ retained: retained(), runGh });
      assert.equal(outcome.status, "refused");
      if (pr.state === "closed") assert(outcome.reason.includes("closed"));
      assert.equal(calls.filter((c) => c.args.includes("POST")).length, 0);
    }
  });

  it("refuses self-authored PRs with no POST", async () => {
    const { runGh, calls } = fakeGh({ viewer: { login: AUTHOR } });
    const outcome = await publishReview({ retained: retained(), runGh });
    assert.equal(outcome.status, "refused");
    assert(outcome.reason.includes("self"));
    assert.equal(calls.filter((c) => c.args.includes("POST")).length, 0);
  });

  it("posts one COMMENT review with the pinned commit id on a clean PR", async () => {
    const { runGh, calls } = fakeGh();
    const outcome = await publishReview({ retained: retained(), runGh });
    assert.equal(outcome.status, "published");
    assert.equal(outcome.inlineCount, 1);
    assert.equal(outcome.notedCount, 2);
    assert(outcome.reviewUrl.includes("pullrequestreview"));
    const posts = calls.filter((c) => c.args.includes("POST"));
    assert.equal(posts.length, 1, "exactly one POST");
    const payload = JSON.parse(posts[0].opts.stdin);
    assert.equal(payload.event, "COMMENT");
    assert.equal(payload.commit_id, HEAD);
    assert.equal(payload.comments.length, 1);
    assert.equal(payload.comments[0].side, "RIGHT");
    assert(payload.body.includes(idempotencyMarker(capture.repo, capture.number, HEAD)));
  });

  it("skips the POST when a review carrying the marker already exists", async () => {
    const marker = idempotencyMarker(capture.repo, capture.number, HEAD);
    const { runGh, calls } = fakeGh({
      reviewsBefore: [{ html_url: "https://github.com/x#review-9", body: `stuff\n${marker}` }],
    });
    const outcome = await publishReview({ retained: retained(), runGh });
    assert.equal(outcome.status, "already-published");
    assert.equal(outcome.reviewUrl, "https://github.com/x#review-9");
    assert.equal(calls.filter((c) => c.args.includes("POST")).length, 0);
  });

  it("degrades to a body-only comment naming both commits when the head moved", async () => {
    const { runGh } = fakeGh({ pr: openPr({ head: { sha: MOVED } }) });
    const outcome = await publishReview({ retained: retained(), runGh });
    assert.equal(outcome.status, "published");
    assert.equal(outcome.stale, true);
    assert.equal(outcome.inlineCount, 0);
    assert.equal(outcome.notedCount, 3);
  });

  it("fails closed when the head moves between gates and the POST", async () => {
    let prFetches = 0;
    const behavior = {
      get pr() {
        prFetches += 1;
        return openPr({ head: { sha: prFetches <= 1 ? HEAD : MOVED } });
      },
    };
    const { runGh } = fakeGh(behavior);
    await assert.rejects(
      publishReview({ retained: retained(), runGh }),
      (error) => error instanceof PublishError && error.message.includes("head moved during publication"),
    );
  });

  it("fails closed when the base advances between gates and the POST", async () => {
    let prFetches = 0;
    const behavior = {
      get pr() {
        prFetches += 1;
        return openPr(prFetches <= 1 ? {} : { base: { sha: REBASED } });
      },
    };
    const { runGh, calls } = fakeGh(behavior);
    await assert.rejects(
      publishReview({ retained: retained(), runGh }),
      (error) => error instanceof PublishError && error.message.includes("base moved during publication"),
    );
    assert.equal(calls.filter((c) => c.args.includes("POST")).length, 0, "no POST after the base advanced");
  });

  it("fails closed on a malformed base sha at gate time", async () => {
    const { runGh, calls } = fakeGh({ pr: openPr({ base: {} }) });
    await assert.rejects(
      publishReview({ retained: retained(), runGh }),
      (error) => error instanceof PublishError && error.message.includes("malformed base sha"),
    );
    assert.equal(calls.filter((c) => c.args.includes("POST")).length, 0);
  });

  it("refuses with no gh traffic when the review was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("parent session ended"));
    const { runGh, calls } = fakeGh();
    const outcome = await publishReview({ retained: retained(), signal: controller.signal, runGh });
    assert.equal(outcome.status, "refused");
    assert(outcome.reason.includes("cancelled"));
    assert.equal(calls.length, 0, "a cancelled review performs no gh call at all");
  });

  it("fails closed when the review is cancelled between the re-check and the POST", async () => {
    const controller = new AbortController();
    let prFetches = 0;
    const behavior = {
      get pr() {
        prFetches += 1;
        if (prFetches > 1) controller.abort(new Error("parent session ended"));
        return openPr();
      },
    };
    const { runGh, calls } = fakeGh(behavior);
    await assert.rejects(
      publishReview({ retained: retained(), signal: controller.signal, runGh }),
      (error) => error instanceof PublishError && error.message.includes("cancelled during publication"),
    );
    assert.equal(calls.filter((c) => c.args.includes("POST")).length, 0, "a cancelled review never POSTs");
  });

  it("publishes normally with a live (unaborted) signal threaded through", async () => {
    const controller = new AbortController();
    const { runGh } = fakeGh();
    const outcome = await publishReview({ retained: retained(), signal: controller.signal, runGh });
    assert.equal(outcome.status, "published");
  });

  it("fails closed when one inline comment body exceeds the per-comment cap", async () => {
    const fat = [
      { severity: "P2", title: "huge", file: "a.mjs", line: 2, detail: "x".repeat(60_001), lane: "x" },
    ];
    const { runGh, calls } = fakeGh();
    await assert.rejects(
      publishReview({ retained: retained(defaultSelection(fat), { findings: fat }), runGh }),
      (error) => error instanceof PublishError && error.message.includes("cap 60000"),
    );
    assert.equal(calls.filter((c) => c.args.includes("POST")).length, 0, "the cap fires before the POST");
  });

  it("fails closed when the PR closes or turns draft between gates and the POST", async () => {
    for (const late of [openPr({ state: "closed" }), openPr({ draft: true })]) {
      let prFetches = 0;
      const behavior = {
        get pr() {
          prFetches += 1;
          return prFetches <= 1 ? openPr() : late;
        },
      };
      const { runGh, calls } = fakeGh(behavior);
      await assert.rejects(
        publishReview({ retained: retained(), runGh }),
        (error) => error instanceof PublishError && error.message.includes("during publication"),
      );
      assert.equal(calls.filter((c) => c.args.includes("POST")).length, 0, "no POST after the PR changed state");
    }
  });

  it("fails closed when the authenticated login or the PR author login is missing", async () => {
    const noViewer = fakeGh({ viewer: {} });
    await assert.rejects(
      publishReview({ retained: retained(), runGh: noViewer.runGh }),
      (error) => error instanceof PublishError && error.message.includes("authenticated gh user"),
    );
    const noAuthor = fakeGh({ pr: openPr({ user: {} }) });
    await assert.rejects(
      publishReview({ retained: retained(), runGh: noAuthor.runGh }),
      (error) => error instanceof PublishError && error.message.includes("no author login"),
    );
    for (const fake of [noViewer, noAuthor]) {
      assert.equal(fake.calls.filter((c) => c.args.includes("POST")).length, 0);
    }
  });

  it("fails closed on a definite 4xx POST refusal without a retry POST", async () => {
    const { runGh, calls } = fakeGh({
      post: { code: 1, stdout: "", stderr: "gh: Validation Failed (HTTP 422)", timedOut: false },
    });
    await assert.rejects(
      publishReview({ retained: retained(), runGh }),
      (error) => error instanceof PublishError && error.message.includes("HTTP 422"),
    );
    assert.equal(calls.filter((c) => c.args.includes("POST")).length, 1, "a definite refusal is not retried");
  });

  it("reconciles an uncertain (5xx) write by finding the marker afterwards", async () => {
    const marker = idempotencyMarker(capture.repo, capture.number, HEAD);
    const { runGh } = fakeGh({
      post: { code: 1, stdout: "", stderr: "gh: server error (HTTP 502)", timedOut: false },
      reviewsAfter: [{ html_url: "https://github.com/x#review-10", body: marker }],
    });
    const outcome = await publishReview({ retained: retained(), runGh });
    assert.equal(outcome.status, "published");
    assert.equal(outcome.reconciled, true);
    assert.equal(outcome.reviewUrl, "https://github.com/x#review-10");
  });

  it("fails closed when an uncertain write left no marker-bearing review", async () => {
    const { runGh } = fakeGh({
      post: { code: 1, stdout: "", stderr: "gh: server error (HTTP 500)", timedOut: false },
      reviewsAfter: [],
    });
    await assert.rejects(
      publishReview({ retained: retained(), runGh }),
      (error) => error instanceof PublishError && error.message.includes("did not land"),
    );
  });

  it("fails closed on gh read failures and non-array list responses", async () => {
    const broken = async () => ({ code: 1, stdout: "", stderr: "gh: no (HTTP 404)", timedOut: false });
    await assert.rejects(
      publishReview({ retained: retained(), runGh: broken }),
      (error) => error instanceof PublishError && error.message.includes("fetching PR #33"),
    );
    const notArray = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("api user")) return ghReply({ login: VIEWER });
      if (joined.includes("/files") || joined.includes("/reviews")) return ghReply({ nope: true });
      return ghReply(openPr());
    };
    await assert.rejects(
      publishReview({ retained: retained(), runGh: notArray }),
      (error) => error instanceof PublishError && error.message.includes("non-array"),
    );
  });
});

describe("renderPublishResult", () => {
  it("renders published, skipped, refused, and idempotent-skip outcomes", () => {
    const published = renderPublishResult(capture, {
      status: "published",
      reviewUrl: "https://x/review",
      inlineCount: 2,
      notedCount: 1,
      stale: false,
    });
    assert(published.includes("posted one COMMENT review"));
    assert(published.includes("2 inline comments"));
    assert(published.includes("https://x/review"));
    assert(renderPublishResult(capture, { status: "skipped", reason: "no findings are selected" }).includes("skipped"));
    assert(renderPublishResult(capture, { status: "refused", reason: "PR #33 is a draft" }).includes("refused"));
    const again = renderPublishResult(capture, { status: "already-published", reviewUrl: "https://x/again" });
    assert(again.includes("already published"));
    assert(again.includes("no second POST"));
  });

  it("discloses stale and reconciled publications", () => {
    const text = renderPublishResult(capture, {
      status: "published",
      reviewUrl: "https://x/r",
      inlineCount: 0,
      notedCount: 3,
      stale: true,
      reconciled: true,
    });
    assert(text.includes("body-only"));
    assert(text.includes("reconciled"));
  });
});
