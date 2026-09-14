// I8: large-diff file-backed transport (spec: "diffs ≥200,000 bytes switch to
// file-backed transport (changed-file manifest + required read ranges;
// completeness enforced from tool events)"). Instead of embedding a ≥200 KB
// diff into every lane prompt, each changed file's diff section is written to
// a 0600 file under a 0700 temp directory and the lanes get a manifest with
// required reads. The captured diff stays the authority — the transport files
// are slices of it, never a live checkout. Pure code; the session model never
// runs here (spec: "Architecture A").
import { chmod, mkdtemp, rm, writeFile as defaultWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiffAnchors } from "./adjudicate.mjs";
import { REVIEW_ENVELOPE_BEGIN as MARKER_BEGIN, REVIEW_ENVELOPE_END as MARKER_END } from "./lane.mjs";
// Module cycle note: transport.mjs ↔ adjudicate.mjs ↔ lane.mjs is a cycle by
// design (transport needs the anchor parser, adjudication reuses the lane
// machinery, lanes need the file-backed prompt). Every cross-import here is a
// function referenced only at call time, so no module touches another's
// bindings while evaluating — safe under ESM live bindings in any load order.

export const FILE_BACKED_THRESHOLD_BYTES = 200_000;

export class TransportError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "TransportError";
  }
}

// Splits a unified diff into per-file sections on `diff --git ` boundaries.
// Each section carries its primary display path — the new side (`+++ b/x`)
// when present, the old side (`--- a/x`) for deletions — so renames appear
// once under their post-image name (a finding may anchor either side; the
// section text contains both). Sections with NO ---/+++ header at all
// (binary files: "Binary files a/x and b/x differ"; mode-only changes) take
// their path from the `diff --git a/x b/x` boundary line itself — rejecting
// them would refuse to review any large PR that touches a binary file. The
// boundary path is the fallback, never the preference (a quoted/escaped
// `diff --git` path can carry git's C-style quoting; the ---/+++ forms are
// the canonical ones).
// Header recognition is POSITIONAL (dogfood round-3 P2): a `+++ `-prefixed
// line INSIDE a hunk is added file content ("++ text" renders as "+++ text"),
// indistinguishable from a header by text alone — only lines before the
// section's first `@@` hunk header count as ---/+++ headers. Leading text
// before the first boundary (never produced by `gh pr diff`, but refused
// silently-dropped) attaches to the FIRST section rather than forming a
// pathless section of its own; a diff with no boundary at all is one section.
export function splitDiffSections(diffText) {
  const lines = String(diffText).split(/\r?\n/);
  const sections = [];
  let current = null;
  let primary = null;
  let boundaryPath = null;
  let hadHeader = false;
  let sawHunk = false;
  let preamble = null;
  const push = () => {
    if (current !== null) sections.push({ lines: current, path: primary ?? boundaryPath, hadHeader });
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      push();
      current = preamble ?? [];
      if (preamble !== null) {
        // Preamble rides ON the first real section — it is not a section.
        preamble = null;
      }
      primary = null;
      boundaryPath = boundaryPathOf(line);
      hadHeader = false;
      sawHunk = false;
    } else if (current === null) {
      // Preamble before any boundary: hold it for the first real section; if
      // the whole diff has no boundary, it becomes the single section.
      preamble = preamble ?? [];
      preamble.push(line);
      continue;
    } else if (!sawHunk && /^@@ /.test(line)) {
      sawHunk = true;
    }
    if (!sawHunk) {
      const newSide = /^\+\+\+ (.+)$/.exec(line);
      if (newSide && newSide[1].trim() !== "/dev/null") {
        primary = normalizeSectionPath(newSide[1]);
        hadHeader = true;
      } else if (primary === null) {
        const oldSide = /^--- (.+)$/.exec(line);
        if (oldSide && oldSide[1].trim() !== "/dev/null") {
          primary = normalizeSectionPath(oldSide[1]);
          hadHeader = true;
        }
      }
    }
    current.push(line);
  }
  push();
  if (sections.length === 0 && preamble !== null) {
    sections.push({ lines: preamble, path: null, hadHeader: false });
  }
  if (sections.length === 1 && sections[0].path === null) {
    throw new TransportError("the diff has no recognizable file paths; cannot build a file-backed transport");
  }
  return sections;
}

// `diff --git a/path b/path` — the b-side names the post-image. Only the
// plain unquoted shape is honored (git quotes exotic paths C-style; such a
// section still carries its canonical ---/+++ header lines whenever it has
// content, so the boundary form is only needed for headerless sections,
// where an unparseable exotic name fails closed as before).
function boundaryPathOf(line) {
  const match = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line.trim());
  if (match === null) return null;
  return normalizeSectionPath(match[2]);
}

function normalizeSectionPath(path) {
  return String(path).trim().replace(/^[ab]\//, "");
}

// Builds the transport for a captured envelope. Under the threshold this is a
// no-op ({ mode: "inline" }) — the diff keeps flowing into prompts as before.
// At or above it, every section is written (0600) under a fresh 0700 temp
// directory and the manifest names each file with its new-side changed ranges
// (the same parsing contract adjudicate.mjs validates anchors against).
// Nothing is returned unless the manifest is complete and consistent.
export async function buildFileBackedTransport({
  envelope,
  thresholdBytes = FILE_BACKED_THRESHOLD_BYTES,
  tempRoot = tmpdir(),
  now = () => new Date(),
  // Injectable writer (the capture.mjs runGh pattern): tests drive partial
  // write failures without touching the filesystem's failure modes.
  writeFile = defaultWriteFile,
  // Cancellation/deadline (dogfood round-3 P2): building a pathological
  // transport is all fs work, but a cancelled review or an expired total
  // budget must not wait out thousands of section writes. Checked between
  // writes — coarse by design (each write is tiny); a trip cleans up the
  // partial directory and fails closed.
  signal = null,
  deadlineAt = null,
}) {
  const diffBytes = Buffer.byteLength(envelope.diff, "utf8");
  if (diffBytes < thresholdBytes) return { mode: "inline", diffBytes, thresholdBytes };
  const anchors = parseDiffAnchors(envelope.diff);
  const sections = splitDiffSections(envelope.diff);
  const seen = new Set();
  const files = sections.map((section, index) => {
    if (section.path === null) {
      throw new TransportError(`diff section ${index + 1} has no recognizable path; cannot build a file-backed transport`);
    }
    if (seen.has(section.path)) {
      throw new TransportError(`diff section ${index + 1} repeats path "${section.path}"; cannot build a file-backed transport`);
    }
    seen.add(section.path);
    // A headered section MUST exist in the anchor surface (the manifest and
    // validation share one parsing contract). A headerless section (binary
    // "Binary files … differ", mode-only) has no anchor surface entry BY
    // CONSTRUCTION — its ranges are legitimately empty, not a disagreement.
    const entry = anchors.files.get(section.path);
    if (section.hadHeader && entry === undefined && !anchors.touched.has(section.path)) {
      throw new TransportError(`diff section "${section.path}" is absent from the anchor surface; the manifest would disagree with validation`);
    }
    return {
      path: section.path,
      file: `f-${String(index + 1).padStart(4, "0")}.diff`,
      ranges: (entry?.ranges ?? []).map(([start, end]) => `${start}-${end}`),
      bytes: Buffer.byteLength(section.lines.join("\n"), "utf8"),
      lines: section.lines,
    };
  });
  const dir = await mkdtemp(join(tempRoot, "z-pr-review-transport-"));
  // Sequential writes (dogfood round-1 P2): Promise.all over every section
  // starts one fs op per changed file — unbounded for a pathological
  // multi-thousand-file diff. Writing in order is milliseconds here and
  // carries no concurrency ceiling at all. A failure mid-loop removes the
  // partial directory (dogfood round-2 P2: a leaked half-written transport
  // is captured diff content on disk) before failing closed.
  try {
    for (const file of files) {
      if (signal?.aborted) throw new TransportError("the review was cancelled while building the file-backed transport");
      if (deadlineAt !== null && deadlineAt - Date.now() <= 0) {
        throw new TransportError("the review's total budget expired while building the file-backed transport");
      }
      await writeFile(join(dir, file.file), `${file.lines.join("\n")}\n`, { mode: 0o600 });
      await chmod(join(dir, file.file), 0o600);
    }
  } catch (error) {    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error instanceof TransportError
      ? error
      : new TransportError(`could not write the file-backed transport under ${dir}: ${String(error?.message ?? error).slice(0, 200)}`);
  }
  // `lines` was construction-only scaffolding; the manifest that travels into
  // prompts and results stays lean.
  const manifest = files.map(({ lines, ...rest }) => ({ ...rest, absolutePath: join(dir, rest.file) }));
  return {
    mode: "file-backed",
    dir,
    thresholdBytes,
    diffBytes,
    fileCount: manifest.length,
    files: manifest,
    builtAt: now().toISOString(),
  };
}

function manifestLines(transport) {
  return [
    `Changed files (${transport.fileCount}) — for each: path, new-side changed line ranges,`,
    "and the transport file holding that file's unified-diff section:",
    ...transport.files.map(
      (file) =>
        `- ${file.path}${file.ranges.length ? ` — changed lines ${file.ranges.join(", ")}` : " — (no new-side lines: deletion or rename pre-image)"} — ${file.absolutePath}`,
    ),
  ];
}

// The file-backed lane prompt: same review contract, same output envelope, but
// the diff itself is replaced by the manifest and a REQUIRED-READS rule the
// host enforces from permission events (file granularity — a read request
// carries a path, not line ranges; the ranges above are the lane's guidance).
export function buildFileBackedLanePrompt(envelope, transport, lane = null) {
  const focus = lane === null ? [] : [
    `You are the "${lane.id}" lane (${lane.tier} tier).`,
    `Your focus: ${lane.objective}.`,
    "Report only findings inside your focus; other lanes cover the rest of the review.",
    "",
  ];
  return [
    "You are one reviewer lane of a code-review tool. Review the following pull request.",
    `Repository: ${envelope.repo} — PR #${envelope.pr.number} "${envelope.pr.title}"`,
    `Base ${envelope.pr.base.refName} -> Head ${envelope.pr.head.refName}`,
    "",
    ...focus,
    "This pull request is large, so the diff is not embedded here. Each changed file's",
    "diff section is a file on disk (unified diff: headers, hunks, +/- lines).",
    "",
    "REQUIRED READS — you MUST read every listed transport file (view tool) before",
    "reporting; the host tracks your reads and rejects a report with unread files.",
    "Read the repository's current files too when unchanged context helps.",
    "",
    ...manifestLines(transport),
    "",
    "Report only defects you can ground in what you read: correctness bugs, contract",
    "violations, security, performance, or resource problems. Skip style nits you cannot",
    "justify. For each finding give a JSON object with fields: severity (P0|P1|P2|P3|nit),",
    "title (one sentence), file (path from the manifest), line (line number in the new",
    "file), detail (why it is a problem, citing what you read).",
    "",
    "Output contract — follow it exactly:",
    `1. Your ENTIRE response is ${MARKER_BEGIN} on its own line, then the findings`,
    `   as one JSON array, then ${MARKER_END} on its own line.`,
    "2. Nothing else before, between, or after those two marker lines.",
    "3. If you find nothing, the array is empty: [].",
  ].join("\n");
}

// The file-backed adjudicator prompt: candidates plus the same manifest (the
// adjudicator judges against the same frozen diff slices the lanes reviewed —
// never a live checkout). Its reads are not coverage-enforced like a lane's
// (merging candidates needs targeted reads, not the whole surface); it must at
// least anchor every surviving candidate, and its output is re-validated
// host-side exactly as before.
export function buildFileBackedAdjudicatorPrompt(envelope, transport, candidates) {
  return [
    "You are the adjudicator of a code-review tool. Several reviewer lanes have reported",
    "candidate findings for the pull request below. Merge them into one final list:",
    "- Merge duplicates and overlapping reports of the same defect into one finding; list the",
    "  reporting lane ids in its \"sources\" array.",
    "- Drop candidates not grounded in the diff, and re-classify severity conservatively",
    "  (P0/P1 only for defects you can substantiate from the diff; prefer the lower rung).",
    "- Keep the most precise anchor (file + line in the new file) and the best evidence quote",
    "  in detail. Do not invent anchors or evidence that are not in the candidates or the diff.",
    "The pull request is large: each changed file's diff section is a file on disk (unified",
    "diff). Read the transport files you need to judge the candidates — at minimum every",
    "file a surviving candidate anchors to.",
    "",
    ...manifestLines(transport),
    "",
    "For each final finding give a JSON object with fields: severity (P0|P1|P2|P3|nit), title",
    "(one sentence), file (path from the manifest), line (line number in the new file), detail",
    "(why it is a problem, citing the diff), sources (array of reporting lane ids).",
    "",
    "Output contract — follow it exactly:",
    `1. Your ENTIRE response is ${MARKER_BEGIN} on its own line, then the findings`,
    `   as one JSON array, then ${MARKER_END} on its own line.`,
    "2. Nothing else before, between, or after those two marker lines.",
    "3. If nothing survives, the array is empty: [].",
    "",
    "Candidate findings reported by the lanes:",
    JSON.stringify(candidates, null, 2),
  ].join("\n");
}

// One line of disclosure for reports: enough to tell a user their review ran
// through disk transport without leaking the manifest's bulk.
export function describeTransport(transport) {
  if (transport?.mode !== "file-backed") return null;
  return `file-backed transport: ${transport.diffBytes.toLocaleString("en-US")}-byte diff across ${transport.fileCount} file${transport.fileCount === 1 ? "" : "s"} — lanes read per-file diff sections from ${transport.dir} (required reads enforced)`;
}
