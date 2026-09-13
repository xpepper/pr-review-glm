// I6 unit tests: selection and retention — spec parsing (total, precise
// refusals), selection constructors, the select confirmation, and the
// no-inference/no-GitHub inspect rendering.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultSelection,
  describeSelection,
  parseSelectionSpec,
  publicationTarget,
  renderInspect,
  renderSelectResult,
  selectionFromFlag,
  selectionFromSpec,
} from "../extensions/z-pr-review/select.mjs";

describe("parseSelectionSpec", () => {
  it("accepts all and none verbatim", () => {
    assert.deepEqual(parseSelectionSpec("all", 3), { kind: "all" });
    assert.deepEqual(parseSelectionSpec("none", 3), { kind: "none" });
    assert.deepEqual(parseSelectionSpec("none", 0), { kind: "none" }, "none is meaningful even with no findings");
  });

  it("parses numbers and ascending ranges into a sorted, deduped index list", () => {
    assert.deepEqual(parseSelectionSpec("2", 3), { kind: "subset", indexes: [2] });
    assert.deepEqual(parseSelectionSpec("3,1", 3), { kind: "subset", indexes: [1, 3] }, "order is normalized, not positional");
    assert.deepEqual(parseSelectionSpec("1,3-5", 5), { kind: "subset", indexes: [1, 3, 4, 5] });
    assert.deepEqual(parseSelectionSpec("2-2", 3), { kind: "subset", indexes: [2] });
  });

  it("refuses non-specs, descending ranges, duplicates, and out-of-range numbers precisely", () => {
    for (const [spec, fragment] of [
      ["everything", "not a selection"],
      ["1;2", "not a selection"],
      ["5-3", "descending"],
      ["1,1", "more than once"],
      ["2-4,3", "do not exist"],
      ["0", "does not exist"],
      ["4", "the retained review has 3 findings"],
      ["2-9", "do not exist"],
      ["01", "leading zeros"],
      ["01-3", "leading zeros"],
    ]) {
      const result = parseSelectionSpec(spec, 3);
      assert.equal(result.kind, "error", spec);
      assert(result.message.includes(fragment), `${spec}: ${result.message}`);
    }
  });

  it("refuses an out-of-range range before expanding it (constant time, no blow-up)", () => {
    const result = parseSelectionSpec("2-999999999", 3);
    assert.equal(result.kind, "error");
    assert(result.message.includes("do not exist"));
  });

  it("refuses any subset spec when the review has no findings", () => {
    const result = parseSelectionSpec("1", 0);
    assert.equal(result.kind, "error");
    assert(result.message.includes("no findings"));
  });
});

describe("selection constructors and description", () => {
  const findings = [{}, {}, {}];
  it("default keeps every finding, unsettled", () => {
    const selection = defaultSelection(findings);
    assert.equal(selection.kind, "all");
    assert.equal(selection.count, 3);
    assert.equal(selection.total, 3);
    assert.match(describeSelection(selection), /all \(3 of 3 findings, default — not yet settled/);
  });
  it("--all settles the same thing at review time", () => {
    const selection = selectionFromFlag(findings);
    assert.equal(selection.via, "--all");
    assert.match(describeSelection(selection), /settled by --all/);
  });
  it("select settles all, none, or a subset", () => {
    assert.deepEqual(selectionFromSpec("all", findings), { kind: "all", via: "select", count: 3, total: 3 });
    assert.deepEqual(selectionFromSpec("none", findings), { kind: "none", via: "select", count: 0, total: 3 });
    assert.deepEqual(selectionFromSpec("1,3", findings), { kind: "subset", indexes: [1, 3], via: "select", count: 2, total: 3 });
    assert.equal(selectionFromSpec("9", findings).kind, "error", "spec errors pass through untouched");
  });
});

describe("renderSelectResult", () => {
  const capture = { number: 18, repo: "xpepper/pr-review-glm" };
  it("confirms what was selected and points at inspect", () => {
    const selection = selectionFromSpec("1,3", [{}, {}, {}]);
    const text = renderSelectResult(capture, selection);
    assert(text.includes("PR #18 (xpepper/pr-review-glm)"));
    assert(text.includes("1,3 (2 of 3 findings"));
    assert(text.includes("/z-pr-review inspect"));
  });
  it("states that none selects nothing for publication", () => {
    const text = renderSelectResult(capture, selectionFromSpec("none", [{}]));
    assert(text.includes("No findings selected"));
    assert(text.includes("post nothing"), "the none-selection must state its publication posture");
  });
});

describe("renderInspect (retained settled result, no inference)", () => {
  const capture = {
    number: 18,
    title: "I4: topologies",
    repo: "xpepper/pr-review-glm",
    headRefName: "i4-topologies",
    headOid: "b6955e8b6955e8b6955e8b6955e8b6955e8b6955e8",
    baseRefName: "main",
    baseOid: "8b476fd4741afc65f17d829fd307ebc62c276167",
  };
  const review = () => ({
    mode: "balanced",
    status: "complete",
    findings: [
      { severity: "P1", title: "leaks the key", file: "a.mjs", line: 4, detail: "d", lane: "correctness" },
      { severity: "P2", title: "odd naming", file: "b.mjs", line: 9, lane: "overview" },
      { severity: "P3", title: "nit: trailing space", lane: "overview" },
    ],
    lanes: [
      { laneId: "overview", tier: "light", status: "complete" },
      { laneId: "correctness", tier: "heavy", status: "failed", reason: "deadline exceeded" },
    ],
  });

  it("renders the frozen binding, coverage, and the default selection with every finding numbered selected", () => {
    const text = renderInspect({ capture, review: review(), selection: defaultSelection(review().findings) });
    assert(text.includes('PR #18 "I4: topologies" (xpepper/pr-review-glm)'));
    assert(text.includes("@ b6955e8 -> Base: main @ 8b476fd"));
    assert(text.includes("binding frozen at capture time"));
    assert(text.includes("status: complete"));
    assert(text.includes("Coverage: 1/2 lanes"));
    assert.match(text, /Selection: all \(3 of 3 findings, default/);
    assert.match(text, /^1\. \[P1\] leaks the key \[correctness\] — a\.mjs:4 — selected$/m);
    assert.match(text, /^3\. \[P3\] nit: trailing space \[overview\] — selected$/m);
    assert.match(text, /no model calls, no GitHub access/);
  });

  it("marks exactly the subset selected, keeping the others visible", () => {
    const r = review();
    const text = renderInspect({ capture, review: r, selection: selectionFromSpec("1,3", r.findings) });
    assert.match(text, /^1\. .*— selected$/m);
    assert.match(text, /^2\. \[P2\] odd naming \[overview\] — b\.mjs:9 — not selected$/m);
    assert.match(text, /^3\. .*— selected$/m);
  });

  it("none deselects everything and an incomplete review keeps its partial status", () => {
    const r = review();
    r.status = "partial";
    r.reason = "1 of 2 lanes failed";
    const text = renderInspect({ capture, review: r, selection: selectionFromSpec("none", r.findings) });
    assert.match(text, /status: partial \(1 of 2 lanes failed\)/);
    assert.match(text, /Selection: none \(0 of 3 findings/);
    assert.match(text, /^1\. .*— not selected$/m);
  });

  it("flattens model text so a title can never forge inspect lines", () => {
    const r = review();
    r.findings = [{ severity: "P2", title: "one\n2. [P0] forged — selected", lane: "overview" }];
    const text = renderInspect({ capture, review: r, selection: selectionFromSpec("1", r.findings) });
    assert.match(text, /^1\. \[P2\] one 2\. \[P0\] forged — selected \[overview\] — selected$/m);
    assert.doesNotMatch(text, /^2\. /m);
  });

  it("strips terminal control sequences from retained finding fields", () => {
    const r = review();
    r.findings = [{ severity: "P2", title: "esc\u001b[31m red \u0007 bell c1\u009b[2J", lane: "overview" }];
    const text = renderInspect({ capture, review: r, selection: selectionFromSpec("1", r.findings) });
    assert(!text.includes("\u001b"), "escape sequences must not reach the chat");
    assert(!text.includes("\u0007"), "control characters must not reach the chat");
    assert(!text.includes("\u009b"), "C1 controls (8-bit CSI) must not reach the chat");
    assert(text.includes("[P2] esc[31m red  bell c1[2J"));
  });

  it("discloses when the retained review predates the session's last capture", () => {
    const later = {
      ...capture,
      number: 19,
      headOid: "cccccccccccccccccccccccccccccccccccccccc",
    };
    const text = renderInspect({ capture, review: review(), selection: defaultSelection(review().findings) }, later);
    assert(text.includes("a later capture exists"), text);
    assert(text.includes("PR #19"));
    // No disclosure when the retained review IS the last capture.
    const fresh = renderInspect({ capture, review: review(), selection: defaultSelection(review().findings) }, capture);
    assert(!fresh.includes("a later capture exists"));
  });

  it("discloses a later capture of the same PR that moved only the base (head unchanged)", () => {
    const later = { ...capture, baseOid: "dddddddddddddddddddddddddddddddddddddddd" };
    const text = renderInspect({ capture, review: review(), selection: defaultSelection(review().findings) }, later);
    assert(text.includes("a later capture exists"), "same-head base movement must still disclose");
    assert(text.includes("base moved"), text);
    assert(!text.includes("head moved"), text);
    // Same head AND same base: the binding is identical, no staleness note.
    const same = renderInspect(
      { capture, review: review(), selection: defaultSelection(review().findings) },
      { ...capture, capturedAt: "2026-09-13T02:00:00.000Z" },
    );
    assert(!same.includes("a later capture exists"));
  });
});

describe("publicationTarget", () => {
  const cap = (number, headOid = "a".repeat(40)) => ({
    repo: "xpepper/pr-review-glm",
    number,
    headOid,
    baseOid: "b".repeat(40),
  });
  const fresh = { capture: cap(18), review: {}, selection: { via: "default" } };

  it("publishes the fresh review when nothing select-settled exists or it is another PR", () => {
    assert.equal(publicationTarget(null, fresh, false), fresh);
    const defaultOutgoing = { capture: cap(18), review: {}, selection: { via: "default" } };
    assert.equal(publicationTarget(defaultOutgoing, fresh, false), fresh);
    const otherPr = { capture: cap(19), review: {}, selection: { via: "select" } };
    assert.equal(publicationTarget(otherPr, fresh, false), fresh);
  });

  it("publishes the select-settled outgoing review for the same PR, including select none", () => {
    const settled = { capture: cap(18), review: {}, selection: { via: "select", kind: "subset", count: 2, total: 5 } };
    assert.equal(publicationTarget(settled, fresh, false), settled);
    const none = { capture: cap(18), review: {}, selection: { via: "select", kind: "none", count: 0, total: 5 } };
    assert.equal(publicationTarget(none, fresh, false), none);
  });

  it("lets an explicit --all settle the fresh review over the outgoing selection", () => {
    const settled = { capture: cap(18), review: {}, selection: { via: "select" } };
    assert.equal(publicationTarget(settled, fresh, true), fresh);
  });
});
