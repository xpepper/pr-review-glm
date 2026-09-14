// I8 unit tests: large-diff file-backed transport — section splitting, the
// threshold decision, per-file transport construction (contents, modes,
// manifest ranges — the same anchor contract adjudication validates with),
// the manifest-form prompts, and the fail-closed consistency refusals. All
// filesystem work happens under injected temp roots; no SDK, no network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  FILE_BACKED_THRESHOLD_BYTES,
  TransportError,
  buildFileBackedAdjudicatorPrompt,
  buildFileBackedLanePrompt,
  buildFileBackedTransport,
  describeTransport,
  splitDiffSections,
} from "../extensions/z-pr-review/transport.mjs";
import { REVIEW_ENVELOPE_BEGIN, REVIEW_ENVELOPE_END } from "../extensions/z-pr-review/lane.mjs";

const TWO_FILE_DIFF = [
  "diff --git a/a.mjs b/a.mjs",
  "index 1111111..2222222 100644",
  "--- a/a.mjs",
  "+++ b/a.mjs",
  "@@ -1,2 +1,3 @@",
  " context",
  "+added",
  " context",
  "diff --git a/b.mjs b/b.mjs",
  "index 3333333..4444444 100644",
  "--- a/b.mjs",
  "+++ b/b.mjs",
  "@@ -2,1 +2,2 @@",
  " context",
  "+other",
  "diff --git a/gone.mjs b/gone.mjs",
  "index 5555555..0000000 100644",
  "--- a/gone.mjs",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-deleted",
].join("\n");

const ENVELOPE = {
  kind: "z-pr-review-capture",
  schemaVersion: 1,
  repo: "xpepper/pr-review-glm",
  pr: { number: 44, title: "I8", base: { refName: "main" }, head: { refName: "i8" } },
  diff: TWO_FILE_DIFF,
};

let tempRoot;
describe("splitDiffSections", () => {
  it("splits on diff --git boundaries, one primary path per section (new side preferred, old side for deletions)", () => {
    const sections = splitDiffSections(TWO_FILE_DIFF);
    assert.deepEqual(sections.map((s) => s.path), ["a.mjs", "b.mjs", "gone.mjs"]);
    assert.ok(sections[0].lines.join("\n").includes("diff --git a/a.mjs b/a.mjs"));
    assert.ok(sections[2].lines.join("\n").includes("-deleted"));
  });
  it("refuses a diff with no recognizable file paths", () => {
    assert.throws(() => splitDiffSections("just some text\nno paths\n"), TransportError);
  });
});

describe("buildFileBackedTransport", () => {
  before(() => { tempRoot = mkdtempSync(join(tmpdir(), "z-pr-review-transport-test-")); });
  after(() => rmSync(tempRoot, { recursive: true, force: true }));

  it("is a no-op below the threshold (inline mode, nothing written)", async () => {
    const transport = await buildFileBackedTransport({ envelope: ENVELOPE, tempRoot });
    assert.equal(transport.mode, "inline");
    assert.equal(transport.diffBytes, Buffer.byteLength(TWO_FILE_DIFF, "utf8"));
  });

  it("at/above the threshold writes one 0600 file per section and a manifest with new-side ranges", async () => {
    const transport = await buildFileBackedTransport({ envelope: ENVELOPE, thresholdBytes: 1, tempRoot });
    assert.equal(transport.mode, "file-backed");
    assert.equal(transport.fileCount, 3);
    assert.deepEqual(transport.files.map((f) => f.path), ["a.mjs", "b.mjs", "gone.mjs"]);
    // Ranges are the anchor contract: new-side changed lines per file; a
    // deletion has none (a finding may still anchor its pre-image).
    assert.deepEqual(transport.files[0].ranges, ["1-3"]);
    assert.deepEqual(transport.files[1].ranges, ["2-3"]);
    assert.deepEqual(transport.files[2].ranges, []);
    for (const file of transport.files) {
      const content = readFileSync(file.absolutePath, "utf8");
      assert.ok(content.includes("diff --git"), `${file.file} carries its file's diff section`);
      const mode = statSync(file.absolutePath).mode & 0o777;
      assert.equal(mode, 0o600, `${file.file} is 0600`);
    }
    const dirMode = statSync(transport.dir).mode & 0o777;
    assert.equal(dirMode, 0o700, "the transport directory is 0700");
    assert.equal(statSync(transport.dir).mode & 0o777, 0o700);
  });

  it("refuses inconsistent diffs instead of building a manifest validation would disagree with", async () => {
    // A path repeated across sections is ambiguous — fail closed.
    const repeated = TWO_FILE_DIFF + "\n" + ["diff --git a/a.mjs b/a.mjs", "--- a/a.mjs", "+++ b/a.mjs", "@@ -1,1 +1,1 @@", "-x", "+y"].join("\n");
    await assert.rejects(
      buildFileBackedTransport({ envelope: { ...ENVELOPE, diff: repeated }, thresholdBytes: 1, tempRoot }),
      (error) => error instanceof TransportError && /repeats path/.test(error.message),
    );
  });
});

describe("file-backed prompts", () => {
  it("the lane prompt carries the manifest and required-reads rule, never the embedded diff", async () => {
    const tempRoot2 = mkdtempSync(join(tmpdir(), "z-pr-review-transport-test2-"));
    try {
      const transport = await buildFileBackedTransport({ envelope: ENVELOPE, thresholdBytes: 1, tempRoot: tempRoot2 });
      const prompt = buildFileBackedLanePrompt(ENVELOPE, transport);
      assert.match(prompt, /not embedded here/);
      assert.match(prompt, /REQUIRED READS/);
      assert.match(prompt, /Changed files \(3\)/);
      assert.match(prompt, /- a\.mjs — changed lines 1-3 — \S+f-0001\.diff/);
      assert.match(prompt, /- gone\.mjs — \(no new-side lines: deletion or rename pre-image\)/);
      assert.ok(prompt.includes(transport.files[0].absolutePath), "the manifest names the transport file paths to read");
      assert.ok(!prompt.includes("@@ -1,2 +1,3 @@"), "no hunk headers in the prompt — the diff text lives in the transport files");
      assert.ok(prompt.includes(REVIEW_ENVELOPE_BEGIN) && prompt.includes(REVIEW_ENVELOPE_END), "the output contract is unchanged");
      const focused = buildFileBackedLanePrompt(ENVELOPE, transport, { id: "correctness", tier: "heavy", objective: "races" });
      assert.match(focused, /"correctness" lane \(heavy tier\)/);
    } finally {
      rmSync(tempRoot2, { recursive: true, force: true });
    }
  });

  it("the adjudicator prompt carries candidates plus the manifest (no embedded diff)", async () => {
    const tempRoot2 = mkdtempSync(join(tmpdir(), "z-pr-review-transport-test3-"));
    try {
      const transport = await buildFileBackedTransport({ envelope: ENVELOPE, thresholdBytes: 1, tempRoot: tempRoot2 });
      const candidates = [{ severity: "P2", title: "t", file: "a.mjs", line: 2, detail: "d" }];
      const prompt = buildFileBackedAdjudicatorPrompt(ENVELOPE, transport, candidates);
      assert.match(prompt, /adjudicator/);
      assert.ok(prompt.includes(JSON.stringify(candidates, null, 2)), "candidates ride in full");
      assert.match(prompt, /Changed files \(3\)/);
      assert.ok(!prompt.includes("```diff"), "no embedded diff fence");
      assert.ok(prompt.includes(REVIEW_ENVELOPE_END), "same output contract");
    } finally {
      rmSync(tempRoot2, { recursive: true, force: true });
    }
  });
});

describe("describeTransport", () => {
  it("discloses file-backed mode; inline is silent", async () => {
    const tempRoot2 = mkdtempSync(join(tmpdir(), "z-pr-review-transport-test4-"));
    try {
      const transport = await buildFileBackedTransport({ envelope: ENVELOPE, thresholdBytes: 1, tempRoot: tempRoot2 });
      const text = describeTransport(transport);
      assert.match(text, /file-backed transport/);
      assert.match(text, /3 files/);
      assert.equal(describeTransport({ mode: "inline" }), null);
      assert.equal(describeTransport(null), null);
    } finally {
      rmSync(tempRoot2, { recursive: true, force: true });
    }
  });
});

describe("FILE_BACKED_THRESHOLD_BYTES", () => {
  it("is the spec's 200,000-byte switch point", () => {
    assert.equal(FILE_BACKED_THRESHOLD_BYTES, 200_000);
  });
});

// Dogfood round-1 fold: headerless sections (binary files, mode-only
// changes) carry their boundary path instead of refusing the whole review.
describe("splitDiffSections (headerless sections, fold round 1)", () => {
  it("binary and mode-only sections take their path from the diff --git boundary line", () => {
    const diff = [
      "diff --git a/src/a.mjs b/src/a.mjs",
      "--- a/src/a.mjs",
      "+++ b/src/a.mjs",
      "@@ -1,1 +1,2 @@",
      " ctx",
      "+x",
      "diff --git a/logo.png b/logo.png",
      "index 1111..2222 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "diff --git a/tool.sh b/tool.sh",
      "old mode 100755",
      "new mode 100644",
    ].join("\n");
    const sections = splitDiffSections(diff);
    assert.deepEqual(sections.map((s) => s.path), ["src/a.mjs", "logo.png", "tool.sh"]);
    assert.deepEqual(sections.map((s) => s.hadHeader), [true, false, false]);
  });
  it("a headerless section still builds a transport entry (empty ranges) instead of failing the review", async () => {
    const root = mkdtempSync(join(tmpdir(), "z-pr-review-transport-binary-"));
    try {
      const diff = [
        "diff --git a/logo.png b/logo.png",
        "index 1111..2222 100644",
        "Binary files a/logo.png and b/logo.png differ",
        "diff --git a/src/a.mjs b/src/a.mjs",
        "--- a/src/a.mjs",
        "+++ b/src/a.mjs",
        "@@ -1,1 +1,2 @@",
        " ctx",
        "+x",
      ].join("\n");
      const transport = await buildFileBackedTransport({ envelope: { ...ENVELOPE, diff }, thresholdBytes: 1, tempRoot: root });
      assert.equal(transport.fileCount, 2);
      assert.equal(transport.files[0].path, "logo.png");
      assert.deepEqual(transport.files[0].ranges, []);
      assert.deepEqual(transport.files[1].ranges, ["1-2"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Fold round 2: a failed transport write removes the partial directory — a
// leaked half-written transport is captured diff content on disk.
describe("buildFileBackedTransport partial-failure cleanup (fold round 2)", () => {
  it("removes the directory when a section write fails, failing closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "z-pr-review-transport-partial-"));
    try {
      const { readdirSync } = await import("node:fs");
      const { writeFile: realWrite } = await import("node:fs/promises");
      let written = 0;
      const failingWrite = async (path, data, opts) => {
        written += 1;
        if (written === 2) throw new Error("ENOSPC: simulated disk full");
        return realWrite(path, data, opts);
      };
      await assert.rejects(
        buildFileBackedTransport({ envelope: ENVELOPE, thresholdBytes: 1, tempRoot: root, writeFile: failingWrite }),
        (error) => error instanceof TransportError && /could not write the file-backed transport/.test(error.message),
      );
      assert.equal(written, 2, "the first section wrote, the second failed");
      assert.deepEqual(readdirSync(root), [], "the partially written transport directory was removed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
