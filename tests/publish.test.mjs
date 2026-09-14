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
// The capture's frozen base (capture.baseOid): the live PR default matches it
// so the happy path is NOT stale-by-base.
const BASE = "3333333333333333333333333333333333333333";
const BASE_MOVED = "4444444444444444444444444444444444444444";
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
  baseOid: BASE,
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
      currentBase: BASE,
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
    assert(publication.body.includes(idempotencyMarker(capture.repo, capture.number, HEAD, BASE)));
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
      currentBase: BASE,
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
      currentBase: BASE,
      stale: true,
    });
    assert.equal(publication.inline.length, 0);
    assert(publication.body.includes(HEAD));
    assert(publication.body.includes(MOVED));
    assert(publication.body.includes(BASE), "the frozen base is named too");
    assert(publication.body.includes("named in this note"));
    assert(publication.body.includes(idempotencyMarker(capture.repo, capture.number, HEAD, BASE)),
      "the stale publication carries its own capture binding's marker, never the live head's — a fresh review at the moved head must not be suppressed");
  });

  it("strips C1 control characters (8-bit CSI included) from model text", () => {
    const hostile = [
      { severity: "P2", title: "csi\u009b[31mred\u009b[0m", file: "a.mjs", line: 2, lane: "x" },
    ];
    const publication = buildPublication({
      capture,
      review,
      selected: hostile,
      anchorMap: anchorMapFromFiles(filesJson),
      currentHead: HEAD,
      currentBase: BASE,
      stale: false,
    });
    assert(!publication.inline[0].body.includes("\u009b"));
    const noted = buildPublication({
      capture,
      review,
      selected: [{ ...hostile[0], file: undefined, line: undefined }],
      anchorMap: anchorMapFromFiles(filesJson),
      currentHead: HEAD,
      currentBase: BASE,
      stale: false,
    });
    assert(!noted.body.includes("\u009b"));
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
      currentBase: BASE,
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
      currentBase: BASE,
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
      currentBase: BASE,
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
      currentBase: BASE,
      stale: false,
    });
    assert(publication.body.includes("Coverage: 1/1 lanes"));
    assert(publication.body.includes("partial"));
  });

  it("fails closed during composition once the body notes trip the cap", () => {
    const fat = [
      // Unanchorable lines force both findings into body notes.
      { severity: "P2", title: "fat one", file: "a.mjs", line: 999, detail: "x".repeat(40_000), lane: "x" },
      { severity: "P2", title: "fat two", file: "a.mjs", line: 998, detail: "y".repeat(40_000), lane: "x" },
    ];
    assert.throws(
      () =>
        buildPublication({
          capture,
          review,
          selected: fat,
          anchorMap: anchorMapFromFiles(filesJson),
          currentHead: HEAD,
          currentBase: BASE,
          stale: false,
        }),
      (error) => error instanceof PublishError && error.message.includes("cap"),
      "the cap fires while composing, before the complete payload exists",
    );
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
    assert(payload.body.includes(idempotencyMarker(capture.repo, capture.number, HEAD, BASE)));
  });

  it("skips the POST when a review carrying the marker already exists", async () => {
    const marker = idempotencyMarker(capture.repo, capture.number, HEAD, BASE);
    const { runGh, calls } = fakeGh({
      reviewsBefore: [{ user: { login: VIEWER }, html_url: "https://github.com/x#review-9", body: `stuff\n${marker}` }],
    });
    const outcome = await publishReview({ retained: retained(), runGh });
    assert.equal(outcome.status, "already-published");
    assert.equal(outcome.reviewUrl, "https://github.com/x#review-9");
    assert.equal(calls.filter((c) => c.args.includes("POST")).length, 0);
  });

  it("does not treat another user's marker-bearing review as its own publication", async () => {
    const marker = idempotencyMarker(capture.repo, capture.number, HEAD, BASE);
    const { runGh, calls } = fakeGh({
      reviewsBefore: [{ user: { login: AUTHOR }, html_url: "https://github.com/x#forged", body: `noise\n${marker}` }],
    });
    const outcome = await publishReview({ retained: retained(), runGh });
    assert.equal(outcome.status, "published", "a forged marker in someone else's review must not suppress publication");
    assert.equal(calls.filter((c) => c.args.includes("POST")).length, 1);
  });

  it("a stale publication's marker never suppresses a distinct fresh review at the moved head (dogfood r5 P1)", async () => {
    // Stateful fake: every POST lands in the shared review list, so the second
    // publication's idempotency scan sees exactly what the first one posted.
    const reviews = [];
    const posts = [];
    const runGh = async (args, opts = {}) => {
      const joined = args.join(" ");
      if (joined.includes("api user")) return ghReply({ login: VIEWER });
      if (args.includes("POST")) {
        posts.push(JSON.parse(opts.stdin));
        const review = { user: { login: VIEWER }, html_url: `https://github.com/x#r${posts.length}`, body: posts[posts.length - 1].body };
        reviews.push(review);
        return ghReply({ html_url: review.html_url });
      }
      if (joined.includes("/reviews")) return ghReply(reviews);
      if (joined.includes("/files")) return ghReply(filesJson);
      if (joined.includes(`/pulls/${capture.number}`)) return ghReply(openPr({ head: { sha: MOVED }, base: { sha: BASE } }));
      return { code: 1, stdout: "", stderr: `fake gh: unmatched ${joined}`, timedOut: false };
    };
    // Publication 1: captured at HEAD, but the PR has already moved to MOVED —
    // stale, body-only, and its marker names the CAPTURE binding (HEAD+BASE).
    const staleOut = await publishReview({ retained: retained(defaultSelection(findings)), runGh });
    assert.equal(staleOut.status, "published");
    assert.equal(staleOut.stale, true);
    assert(posts[0].body.includes(idempotencyMarker(capture.repo, capture.number, HEAD, BASE)));
    // Publication 2: a FRESH review captured at the moved head — the stale
    // publication above must not occupy this capture binding's slot.
    const atMovedHead = retained(defaultSelection(findings));
    atMovedHead.capture = { ...capture, headOid: MOVED };
    const freshOut = await publishReview({ retained: atMovedHead, runGh });
    assert.equal(freshOut.status, "published", "the stale publication's marker must not suppress the fresh review");
    assert.equal(freshOut.stale, false);
    assert(posts[1].body.includes(idempotencyMarker(capture.repo, capture.number, MOVED, BASE)));
    assert.equal(posts.length, 2);
  });

  it("degrades to a body-only comment naming both commits when the head moved", async () => {
    const { runGh, calls } = fakeGh({ pr: openPr({ head: { sha: MOVED } }) });
    const outcome = await publishReview({ retained: retained(), runGh });
    assert.equal(outcome.status, "published");
    assert.equal(outcome.stale, true);
    assert.equal(outcome.inlineCount, 0);
    assert.equal(outcome.notedCount, 3);
    // A stale publication never anchors inline, so it never fetches files —
    // a >500-file PR must not fail a body-only stale comment.
    assert.equal(calls.filter((c) => c.args.join(" ").includes("/files")).length, 0);
  });

  it("degrades to body-only when the base advanced since capture (head unchanged)", async () => {
    const { runGh, calls } = fakeGh({ pr: openPr({ base: { sha: BASE_MOVED } }) });
    const outcome = await publishReview({ retained: retained(), runGh });
    assert.equal(outcome.status, "published");
    assert.equal(outcome.stale, true);
    assert.equal(outcome.staleHead, false, "the head did NOT move — only the base did");
    assert.equal(outcome.staleBase, true);
    assert.equal(outcome.inlineCount, 0, "findings validated against the captured diff must not anchor on the re-based live diff");
    assert.equal(outcome.notedCount, 3);
    assert.equal(calls.filter((c) => c.args.includes("POST")).length, 1);
  });

  it("accepts lists of exactly the entry cap and refuses only beyond it", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ filename: `f${index}.mjs` }));
    const pageAware = (probeResult) => async (args) => {
      const joined = args.join(" ");
      if (args.includes("POST")) return ghReply({ html_url: "https://github.com/x#pullrequestreview-cap" });
      if (joined.includes("api user")) return ghReply({ login: VIEWER });
      if (joined.includes("/reviews")) return ghReply([]);
      if (joined.includes("/files")) {
        const page = Number(/[?&]page=(\d+)/.exec(joined)[1]);
        const perPage = Number(/[?&]per_page=(\d+)/.exec(joined)[1]);
        if (perPage === 1) return ghReply(probeResult); // the beyond-cap probe
        return ghReply(page <= 5 ? fullPage : []);
      }
      return ghReply(openPr());
    };
    const exactlyAtCap = await publishReview({ retained: retained(), runGh: pageAware([]) });
    assert.equal(exactlyAtCap.status, "published", "exactly 500 changed files is at the cap, not over it");
    await assert.rejects(
      publishReview({ retained: retained(), runGh: pageAware([{}]) }),
      (error) => error instanceof PublishError && error.message.includes("more than 500"),
    );
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
    const marker = idempotencyMarker(capture.repo, capture.number, HEAD, BASE);
    const { runGh } = fakeGh({
      post: { code: 1, stdout: "", stderr: "gh: server error (HTTP 502)", timedOut: false },
      reviewsAfter: [{ user: { login: VIEWER }, html_url: "https://github.com/x#review-10", body: marker }],
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
      publishReview({ retained: retained(), runGh, sleep: async () => {} }),
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

  it("reports base-only staleness as the base advancing, not the head moving", () => {
    const text = renderPublishResult(capture, {
      status: "published",
      reviewUrl: "https://x/r",
      inlineCount: 0,
      notedCount: 3,
      stale: true,
      staleHead: false,
      staleBase: true,
    });
    assert(text.includes("base had advanced"), text);
    assert(!text.includes("head had moved"), text);
    const both = renderPublishResult(capture, {
      status: "published",
      reviewUrl: "https://x/r",
      inlineCount: 0,
      notedCount: 3,
      stale: true,
      staleHead: true,
      staleBase: true,
    });
    assert(both.includes("head and base had moved"), both);
  });
});

// I8: bounded uncertain-write reconciliation (the I7 review P2 — a single
// scan over a lagging listing could fail closed over a landed review and bait
// a duplicating rerun) and the AbortSignal threading through paginated gh
// calls (the I7 review P2 — a cancelled review paged on while holding the
// per-target lock).
describe("publishReview reconciliation and cancellation (I8)", () => {
  const markerReview = (marker) => [{ user: { login: VIEWER }, html_url: "https://github.com/x#review-late", body: marker }];
  const noSleep = async () => {};

  function sequencingGh({ lists, post }) {
    // lists: consumed in order by every non-POST /reviews call; the last entry
    // repeats. Everything else mirrors fakeGh's happy defaults.
    const calls = [];
    let reviewsCall = 0;
    const runGh = async (args, opts = {}) => {
      calls.push({ args, opts });
      const joined = args.join(" ");
      if (joined.includes("api user")) return ghReply({ login: VIEWER });
      if (args.includes("POST")) return post ?? ghReply({ html_url: "https://github.com/x#review-1" });
      if (joined.includes("/reviews")) {
        const list = lists[Math.min(reviewsCall, lists.length - 1)];
        reviewsCall += 1;
        return ghReply(list);
      }
      if (joined.includes("/files")) return ghReply(filesJson);
      if (joined.includes("repos/xpepper/pr-review-glm/pulls/33")) return ghReply(openPr());
      return { code: 1, stdout: "", stderr: `fake gh: unmatched ${joined}`, timedOut: false };
    };
    return { runGh, calls };
  }

  it("reconciles a landed-but-lagging review on a later bounded scan, with the lag disclosed", async () => {
    const marker = idempotencyMarker(capture.repo, capture.number, HEAD, BASE);
    const sleeps = [];
    const { runGh, calls } = sequencingGh({
      post: { code: 1, stdout: "", stderr: "gh: server error (HTTP 502)", timedOut: false },
      lists: [[], [], markerReview(marker)], // pre-POST empty, scan 1 still empty, scan 2 sees it
    });
    const outcome = await publishReview({ retained: retained(), runGh, sleep: async (ms) => sleeps.push(ms) });
    assert.equal(outcome.status, "published");
    assert.equal(outcome.reconciled, true);
    assert.equal(outcome.reconcileScans, 2);
    assert.deepEqual(sleeps, [2000], "exactly one wait between the two scans");
    const scans = calls.filter((c) => !c.args.includes("POST") && c.args.join(" ").includes("/reviews"));
    assert.equal(scans.length, 3, "pre-POST scan + two reconciliation scans, then stop on success");
    const text = renderPublishResult(capture, outcome);
    assert.match(text, /review-scan 2 of 3/, "the render discloses which scan reconciled");
  });

  it("fails closed only after all bounded scans, disclosing the scan count", async () => {
    const sleeps = [];
    const { runGh, calls } = sequencingGh({
      post: { code: 1, stdout: "", stderr: "gh: server error (HTTP 503)", timedOut: false },
      lists: [[]],
    });
    await assert.rejects(
      publishReview({ retained: retained(), runGh, sleep: async (ms) => sleeps.push(ms) }),
      (error) => error instanceof PublishError && /no review carrying the idempotency marker appeared within 3 reconciliation scans/.test(error.message),
    );
    assert.deepEqual(sleeps, [2000, 2000]);
    const scans = calls.filter((c) => !c.args.includes("POST") && c.args.join(" ").includes("/reviews"));
    assert.equal(scans.length, 4, "pre-POST scan + exactly three reconciliation scans");
  });

  it("a cancelled review stops asking gh for anything: no POST happens", async () => {
    const controller = new AbortController();
    const { runGh, calls } = sequencingGh({ lists: [[]] });
    const wrapped = async (args, opts) => {
      const result = await runGh(args, opts);
      // The abort lands right after the first PR fetch — the next gh call
      // (the viewer lookup) must be refused by the signal check.
      controller.abort(new Error("parent session ended"));
      return result;
    };
    await assert.rejects(
      publishReview({ retained: retained(), runGh: wrapped, signal: controller.signal, sleep: noSleep }),
      (error) => error instanceof PublishError && /cancelled while resolving the authenticated gh user/.test(error.message),
    );
    assert.equal(calls.filter((c) => c.args.includes("POST")).length, 0, "nothing was posted");
  });

  it("an abort during the reconciliation scan stops paging instead of continuing scans (the per-PR lock is released)", async () => {
    const controller = new AbortController();
    const { runGh, calls } = sequencingGh({
      post: { code: 1, stdout: "", stderr: "gh: server error (HTTP 500)", timedOut: false },
      lists: [[]],
    });
    const wrapped = async (args, opts) => {
      if (args.includes("POST")) controller.abort(new Error("parent session ended"));
      return runGh(args, opts);
    };
    await assert.rejects(
      publishReview({ retained: retained(), runGh: wrapped, signal: controller.signal, sleep: noSleep }),
      (error) => error instanceof PublishError && /cancelled while reconciling/.test(error.message),
    );
    const scans = calls.filter((c) => !c.args.includes("POST") && c.args.join(" ").includes("/reviews"));
    assert.equal(scans.length, 1, "only the pre-POST scan ran; the aborted reconciliation scan never paged");
  });
});

// Fold round-1 P2: the reconciliation backoff is abort-aware — a cancelled
// review does not sit out the 2s delay before noticing.
describe("publishReview abort-aware reconciliation backoff (fold round 1)", () => {
  it("an abort landing during the backoff throws immediately instead of scanning again", async () => {
    const controller = new AbortController();
    const marker = idempotencyMarker(capture.repo, capture.number, HEAD, BASE);
    const calls = [];
    let reviewsCall = 0;
    const runGh = async (args, opts = {}) => {
      calls.push({ args, opts });
      const joined = args.join(" ");
      if (joined.includes("api user")) return ghReply({ login: VIEWER });
      if (args.includes("POST")) return { code: 1, stdout: "", stderr: "gh: server error (HTTP 500)", timedOut: false };
      if (joined.includes("/reviews")) {
        reviewsCall += 1;
        return ghReply(reviewsCall === 1 ? [] : [markerReview(marker)]); // scan 2 would see it
      }
      if (joined.includes("/files")) return ghReply(filesJson);
      if (joined.includes("repos/xpepper/pr-review-glm/pulls/33")) return ghReply(openPr());
      return { code: 1, stdout: "", stderr: `fake gh: unmatched ${joined}`, timedOut: false };
    };
    const markerReview = (marker) => [{ user: { login: VIEWER }, html_url: "x", body: marker }];
    await assert.rejects(
      publishReview({
        retained: retained(),
        runGh,
        signal: controller.signal,
        sleep: () =>
          new Promise(() => {
            // The abort lands the moment the backoff begins; the sleep itself
            // never settles, so the raced abort rejection is the only outcome.
            controller.abort(new Error("parent session ended"));
          }),
      }),
      (error) => error instanceof PublishError && /cancelled while waiting to reconcile/.test(error.message),
    );
    const scans = calls.filter((c) => !c.args.includes("POST") && c.args.join(" ").includes("/reviews"));
    assert.equal(scans.length, 2, "pre-POST scan + exactly one reconciliation scan; the aborted backoff never reached scan 2");
  });
});
