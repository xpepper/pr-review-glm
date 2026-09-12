// I5: validation and adjudication — the authority path between raw lane
// candidates and the reported findings. Everything here is code-owned and
// deterministic: anchors are checked against the captured diff, severities
// against the ladder, duplicates collapsed, and the per-mode findings policy
// enforced in code (it was prompt-level only until I5). The one model call —
// the adjudicator — runs in an isolated child runtime like a lane (heavy tier,
// envelope output contract, deadlines.adjudicationMs) and its output is
// re-validated by the same host checks before anything is reported: model text
// never gains authority (spec: "Publication gates", "Degradation and budgets").
import { SEVERITIES, runLane } from "./lane.mjs";

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

// Parses a unified diff into the anchor surface host validation checks
// against: which files the diff touches, and for each, the new-file line
// ranges covered by its hunks. Only the diff captured at review time is
// authoritative — never a live checkout.
export function parseDiffAnchors(diffText) {
  const files = new Map();
  const touched = new Set();
  const note = (path) => {
    if (!files.has(path)) files.set(path, { ranges: [], newSide: false });
    return files.get(path);
  };
  let current = null;
  for (const line of String(diffText).split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") continue; // deleted file: old path noted below
      current = note(normalizeDiffPath(target));
      current.newSide = true;
      touched.add(normalizeDiffPath(target));
    } else if (line.startsWith("--- ")) {
      const source = line.slice(4).trim();
      if (source !== "/dev/null") {
        // The pre-image path is touched too (a finding may name either side of
        // a rename), but only the post-image carries new-side hunk ranges.
        note(normalizeDiffPath(source));
        touched.add(normalizeDiffPath(source));
        if (current === null) current = note(normalizeDiffPath(source));
      }
    } else {
      const hunk = HUNK_HEADER.exec(line);
      if (hunk && current !== null) {
        const start = Number(hunk[1]);
        const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        // count 0 = a hunk with no new-side lines (pure deletion context).
        if (count > 0) current.ranges.push([start, start + count - 1]);
      } else if (line.startsWith("diff --git ")) {
        current = null; // file boundary: ranges must not leak across files
      }
    }
  }
  return { files, touched };
}

function normalizeDiffPath(path) {
  return path.replace(/^[ab]\//, "");
}

// Host-side candidate validation (deterministic, per candidate): anchors must
// exist in the diff and lines must fall inside a changed hunk of their file;
// blocking severities must carry evidence (a non-empty detail). A finding
// without a file is kept as a whole-PR observation — it simply cannot be
// inline-anchored later (I7).
export function candidateProblem(candidate, anchors) {
  if (candidate.file !== undefined) {
    const file = normalizeDiffPath(String(candidate.file));
    if (!anchors.touched.has(file)) {
      return `file "${file}" is not touched by the diff`;
    }
    if (candidate.line !== undefined) {
      const entry = anchors.files.get(file);
      if (entry === undefined || !entry.newSide) {
        return `line ${candidate.line} cannot anchor: "${file}" has no new-file side in the diff`;
      }
      const inHunk = entry.ranges.some(([start, end]) => candidate.line >= start && candidate.line <= end);
      if (!inHunk) {
        return `line ${candidate.line} is outside the changed hunks of "${file}"`;
      }
    }
  }
  if (
    (candidate.severity === "P0" || candidate.severity === "P1") &&
    (typeof candidate.detail !== "string" || candidate.detail.trim().length === 0)
  ) {
    return `${candidate.severity} finding carries no evidence (empty detail)`;
  }
  return null;
}

// Code-owned deduplication — the backstop under the adjudicator's merge pass
// and the only dedup that exists when adjudication is degraded. Two findings
// are duplicates when file, line, and normalized title all match; sources/lanes
// are unioned onto the survivor.
export function dedupFindings(findings) {
  const byKey = new Map();
  const kept = [];
  for (const finding of findings) {
    const key = [
      finding.file === undefined ? "" : normalizeDiffPath(String(finding.file)),
      finding.line ?? "",
      String(finding.title).trim().toLowerCase(),
    ].join("\u0000");
    const prior = byKey.get(key);
    if (prior === undefined) {
      byKey.set(key, finding);
      kept.push(finding);
    } else {
      prior.lanes = [...new Set([...(prior.lanes ?? []), ...(finding.lanes ?? [])])];
    }
  }
  return kept;
}

// The adjudicator's candidates pass the same checks lane candidates do, plus
// shape validation of their `sources` field (an optional array of lane ids;
// anything else strips the field rather than dropping the finding).
export function adjudicatedProblem(item, anchors) {
  if (!SEVERITIES.includes(item.severity)) {
    return `severity "${String(item.severity)}" is not on the ladder`;
  }
  if (typeof item.title !== "string" || item.title.trim().length === 0) {
    return "missing or empty title";
  }
  if (item.sources !== undefined && (!Array.isArray(item.sources) || item.sources.some((id) => typeof id !== "string"))) {
    return "sources is not an array of lane ids";
  }
  return candidateProblem(item, anchors);
}

const BLOCKING_POLICY = { quick: ["P0", "P1", "P2"], balanced: ["P0", "P1", "P2"] };

// Per-mode findings policy, enforced in code (I5 moves it out of prompts):
// quick keeps P0–P2; balanced additionally allows at most three diff-anchored
// (file + line) P3/nit candidates; full and deep keep everything. Custom modes
// (C1) have no policy of their own — they keep everything, like full (flagged
// in the I5 PR; a per-mode policy grammar is not warranted in v1).
export function applyModePolicy(mode, findings) {
  const allowed = BLOCKING_POLICY[mode];
  if (allowed === undefined) return { kept: [...findings], dropped: [] };
  const kept = [];
  const dropped = [];
  let hygiene = 0;
  for (const finding of findings) {
    const onLadder = allowed.includes(finding.severity);
    if (onLadder) {
      kept.push(finding);
    } else if (mode === "balanced" && finding.file !== undefined && finding.line !== undefined && hygiene < 3) {
      kept.push(finding);
      hygiene += 1;
    } else {
      dropped.push(finding);
    }
  }
  return { kept, dropped };
}

export function buildAdjudicatorPrompt(envelope, candidates) {
  return [
    "You are the adjudicator of a code-review tool. Several reviewer lanes have reported",
    "candidate findings for the pull request below. Merge them into one final list:",
    "- Merge duplicates and overlapping reports of the same defect into one finding; list the",
    "  reporting lane ids in its \"sources\" array.",
    "- Drop candidates not grounded in the diff, and re-classify severity conservatively",
    "  (P0/P1 only for defects you can substantiate from the diff; prefer the lower rung).",
    "- Keep the most precise anchor (file + line in the new file) and the best evidence quote",
    "  in detail. Do not invent anchors or evidence that are not in the candidates or the diff.",
    "For each final finding give a JSON object with fields: severity (P0|P1|P2|P3|nit), title",
    "(one sentence), file (path from the diff), line (line number in the new file), detail",
    "(why it is a problem, citing the diff), sources (array of reporting lane ids).",
    "",
    "Output contract — follow it exactly:",
    "1. Your ENTIRE response is <<<REVIEW_BEGIN>>> on its own line, then the findings",
    "   as one JSON array, then <<<REVIEW_END>>> on its own line.",
    "2. Nothing else before, between, or after those two marker lines.",
    "3. If nothing survives, the array is empty: [].",
    "",
    "Candidate findings reported by the lanes:",
    JSON.stringify(candidates, null, 2),
    "",
    "The diff:",
    "```diff",
    envelope.diff,
    "```",
  ].join("\n");
}

// The one isolated adjudicator call: a heavy-tier child runtime (the same
// runLane machinery — budgets, envelope contract, cancellation) driven by the
// adjudicator prompt instead of a lane prompt. Its parsed output is
// re-validated host-side before use; a malformed or failed call degrades the
// review rather than poisoning it.
export async function runAdjudication({ envelope, candidates, config, repoRoot, cliPath, deadlineAt, signal = null, createRuntime }) {
  const lane = { id: "adjudicator", tier: "heavy", objective: "merge, deduplicate, and classify candidate findings" };
  const outcome = await runLane({
    lane,
    envelope,
    config,
    repoRoot,
    cliPath,
    deadlineAt,
    signal,
    createRuntime,
    prompt: buildAdjudicatorPrompt(envelope, candidates),
  });
  if (outcome.status !== "complete") {
    return { status: "failed", reason: outcome.reason, findings: [], dropped: [] };
  }
  return { status: "complete", findings: outcome.findings, dropped: outcome.dropped, attempts: outcome.attempts };
}

// Assembles the final review from a finished lane batch: gather complete
// lanes' candidates → host validation against the captured diff → one
// adjudicator call → host re-validation + dedup → per-mode policy. Every drop
// is counted and disclosed; a failed or malformed adjudication degrades to the
// validated candidates (deduped, policy-filtered) with the failure disclosed —
// never a silent merge, never a dropped review.
export async function assembleReview({ batch, mode, envelope, config, repoRoot, cliPath, adjudicationDeadlineAt, signal = null, createRuntime }) {
  const anchors = parseDiffAnchors(envelope.diff);
  const candidates = [];
  for (const lane of batch.lanes) {
    if (lane.status !== "complete") continue;
    for (const finding of lane.findings) candidates.push({ ...finding, lanes: [lane.laneId] });
  }
  const shapingDrops = batch.lanes.reduce((total, lane) => total + lane.dropped.length, 0);
  const validated = [];
  const validationDrops = [];
  for (const candidate of candidates) {
    const problem = candidateProblem(candidate, anchors);
    if (problem === null) validated.push(candidate);
    else validationDrops.push({ title: candidate.title, lane: candidate.lanes[0], reason: problem });
  }

  let adjudication;
  if (validated.length === 0) {
    adjudication = { status: "skipped", reason: "no validated candidates to adjudicate" };
  } else if (adjudicationDeadlineAt !== undefined && adjudicationDeadlineAt - Date.now() <= 0) {
    adjudication = { status: "failed", reason: "budget expired before adjudication", findings: [], dropped: [] };
  } else {
    adjudication = await runAdjudication({
      envelope,
      candidates: validated,
      config,
      repoRoot,
      cliPath,
      deadlineAt: adjudicationDeadlineAt,
      signal,
      createRuntime,
    });
  }

  let merged;
  let adjudicationDrops = 0;
  if (adjudication.status === "complete") {
    // The adjudicator reuses the lane machinery, so its raw output is shaped
    // there (ladder severity + title) before this re-validation runs: those
    // shaping drops are adjudication-stage discards too — count them or they
    // vanish from every drop disclosure.
    adjudicationDrops += adjudication.dropped.length;
    const laneIds = new Set(batch.lanes.map((lane) => lane.laneId));
    const accepted = [];
    for (const item of adjudication.findings) {
      const problem = adjudicatedProblem(item, anchors);
      if (problem !== null) {
        adjudicationDrops += 1;
        continue;
      }
      // `sources` is sanitized to lanes that actually ran; an adjudicator
      // naming unknown lanes attributes nothing it did not receive.
      const sources = (item.sources ?? []).filter((id) => laneIds.has(id));
      accepted.push({ ...item, lanes: sources });
    }
    merged = dedupFindings(accepted);
  } else if (adjudication.status === "skipped") {
    merged = [];
  } else {
    merged = dedupFindings(validated);
  }

  const { kept, dropped: policyDropped } = applyModePolicy(mode, merged);
  const findings = kept.map((finding) => ({
    severity: finding.severity,
    title: finding.title,
    file: finding.file,
    line: finding.line,
    detail: finding.detail,
    lane: finding.lanes?.length ? finding.lanes.join("+") : "adjudicator",
  }));

  const status =
    batch.status !== "complete"
      ? batch.status
      : adjudication.status === "failed"
        ? "degraded"
        : "complete";
  const reason =
    batch.status !== "complete"
      ? batch.reason
      : adjudication.status === "failed"
        ? `adjudication failed: ${adjudication.reason} — reporting unmerged validated candidates`
        : undefined;

  return {
    mode,
    lanes: batch.lanes,
    elapsedMs: batch.elapsedMs,
    status,
    ...(reason !== undefined ? { reason } : {}),
    findings,
    drops: {
      shaping: shapingDrops,
      validation: validationDrops.length,
      adjudication: adjudicationDrops,
      policy: policyDropped.length,
    },
    validationDrops,
    adjudication:
      adjudication.status === "complete"
        ? { status: "complete", merged: merged.length }
        : { status: adjudication.status, reason: adjudication.reason },
  };
}
