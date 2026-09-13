// I6: selection and retention — pure, code-owned logic with no runtime
// dependency. After a review renders, its assembled findings are retained
// in-session with a selection over them (the validated default: all findings).
// The user settles the selection through chat turns — `--all` settles it at
// review time, `/z-pr-review select <spec>` settles or re-settles it afterwards
// — and `/z-pr-review inspect` renders the retained settled result with no
// model calls and no GitHub access. The Copilot SDK command-handler surface has
// no verified interactive-prompt API, so the chat follow-up turn IS the
// elicitation surface (flagged in the I6 PR against the spec's "native
// elicitation" wording).
//
// Nothing here trusts model text for authority: selection operates on the
// already host-validated findings of the retained review, by number.

// A selection spec is "all", "none", or a comma list of finding numbers and
// ascending ranges ("1,3-5"). Numbers refer to the 1-based positions in the
// rendered report, so they can only name findings that survived validation,
// adjudication, and the mode policy. Parsing is total and fails with a precise
// reason — never a silent truncation.
export function parseSelectionSpec(spec, total) {
  const text = String(spec).trim();
  if (text === "all") return { kind: "all" };
  if (text === "none") return { kind: "none" };
  if (!/^[0-9][0-9,\-]*$/.test(text)) {
    return { kind: "error", message: `"${text}" is not a selection. Use all, none, or finding numbers like 1,3-5.` };
  }
  if (total === 0) {
    return { kind: "error", message: "The retained review has no findings — nothing to select." };
  }
  const indexes = [];
  for (const part of text.split(",")) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (range === null) {
      return { kind: "error", message: `"${part}" is not a number or range.` };
    }
    // Leading zeros ("01") are refused for the same reason the PR-number
    // grammar refuses them: one canonical spelling per finding number.
    if (/^0\d/.test(range[1]) || (range[2] !== undefined && /^0\d/.test(range[2]))) {
      return { kind: "error", message: `"${part}" has leading zeros — write finding numbers without them.` };
    }
    const start = Number(range[1]);
    const end = range[2] === undefined ? start : Number(range[2]);
    if (start < 1) {
      return { kind: "error", message: `Finding 0 does not exist — findings are numbered from 1.` };
    }
    if (end < start) {
      return { kind: "error", message: `Range ${part} is descending — write the smaller number first.` };
    }
    // Bounds are validated BEFORE the range is expanded, so a huge range over a
    // small review is refused in constant time instead of materializing.
    if (start > total || end > total) {
      return {
        kind: "error",
        message: `Range ${part} names findings that do not exist — the retained review has ${total} finding${total === 1 ? "" : "s"} (1–${total}).`,
      };
    }
    for (let index = start; index <= end; index++) indexes.push(index);
  }
  if (new Set(indexes).size !== indexes.length) {
    return { kind: "error", message: "The selection names a finding more than once." };
  }
  return { kind: "subset", indexes: [...new Set(indexes)].sort((a, b) => a - b) };
}

// The retained result: the review's assembled findings plus the selection over
// them. `via` records how the current selection was set — "default" (all
// findings, awaiting an explicit selection), "--all" (settled at review time),
// or "select" (settled by /z-pr-review select).
export function defaultSelection(findings) {
  return { kind: "all", via: "default", count: findings.length, total: findings.length };
}

export function selectionFromFlag(findings) {
  return { kind: "all", via: "--all", count: findings.length, total: findings.length };
}

export function selectionFromSpec(spec, findings) {
  const parsed = parseSelectionSpec(spec, findings.length);
  if (parsed.kind === "error") return parsed;
  // `count` is how many findings the selection SELECTS — the subset length,
  // everything for all, nothing for none.
  const count = parsed.kind === "subset" ? parsed.indexes.length : parsed.kind === "all" ? findings.length : 0;
  return { ...parsed, via: "select", count, total: findings.length };
}

export function describeSelection(selection) {
  const what = selection.kind === "subset" ? selection.indexes.join(",") : selection.kind;
  const how = selection.via === "default"
    ? "default — not yet settled by a selection"
    : selection.via === "--all"
      ? "settled by --all at review time"
      : "settled by /z-pr-review select";
  return `${what} (${selection.count} of ${selection.total} finding${selection.total === 1 ? "" : "s"}, ${how})`;
}

// Which retained result an authorized publication posts (I7). A select-settled
// selection for the same PR is the user's settled publication posture — up to
// and including `select none` — so a re-review must never silently discard it
// in favor of the fresh default all-selection. The fresh review wins when
// nothing was settled, when the invocation settles it explicitly with --all,
// or when the settled review belongs to another PR.
export function publicationTarget(outgoing, fresh, explicitAll) {
  if (explicitAll) return fresh;
  if (
    outgoing !== null &&
    outgoing.capture.repo === fresh.capture.repo &&
    outgoing.capture.number === fresh.capture.number &&
    outgoing.selection.via === "select"
  ) {
    return outgoing;
  }
  return fresh;
}

// Renders the confirmation after /z-pr-review select settles a selection.
export function renderSelectResult(capture, selection) {
  return [
    `Selection for PR #${capture.number} (${capture.repo}): ${describeSelection(selection)}`,
    selection.kind === "none"
      ? "No findings selected — a later publication (--comment / autoPostReviews) will post nothing for this review."
      : "The retained result is up to date; /z-pr-review inspect shows it without model calls or GitHub access.",
  ].join("\n");
}

// Retained finding fields are model-influenced text; rendering flattens
// newlines AND strips terminal control characters — C0, DEL, and the C1 range
// (U+0080–U+009F; U+009B is an 8-bit CSI some terminals interpret as ANSI) —
// so a finding can never forge inspect lines or emit escape sequences into
// the chat.
function inspectText(text) {
  return String(text).replace(/\r?\n/g, " ").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g, "");
}

// Renders the retained settled result. Pure text over the in-session state:
// no model calls, no gh, no network — the "inspectable without inference"
// deliverable of I6. `laterCapture` (the session's last capture) is optional
// disclosure: when a follow-up review captured a PR but failed before its own
// retention, the retained result predates that capture and says so.
export function renderInspect(retained, laterCapture = null) {
  const { capture, review, selection } = retained;
  const lines = [
    `Retained review — PR #${capture.number} "${inspectText(capture.title)}" (${capture.repo})`,
    `Head: ${capture.headRefName} @ ${capture.headOid.slice(0, 7)} -> Base: ${capture.baseRefName} @ ${capture.baseOid.slice(0, 7)} (binding frozen at capture time)`,
    `Mode: ${review.mode} — status: ${review.status}${review.reason !== undefined ? ` (${review.reason})` : ""}`,
    `Coverage: ${review.lanes.filter((lane) => lane.status === "complete").length}/${review.lanes.length} lane${review.lanes.length === 1 ? "" : "s"} completed`,
    `Selection: ${describeSelection(selection)}`,
  ];
  // Staleness by a later capture is symmetric in head and base: a capture with
  // the SAME head but a moved base still re-diffs the PR, so the retained
  // review must be disclosed as predating it, not silently treated as current.
  if (
    laterCapture !== null &&
    (laterCapture.headOid !== capture.headOid || laterCapture.baseOid !== capture.baseOid)
  ) {
    const samePr = laterCapture.repo === capture.repo && laterCapture.number === capture.number;
    const moved = [
      laterCapture.headOid !== capture.headOid ? "head" : null,
      laterCapture.baseOid !== capture.baseOid ? "base" : null,
    ].filter(Boolean);
    lines.push(
      `Note: a later capture exists in this session (PR #${laterCapture.number} @ ${laterCapture.headOid.slice(0, 7)})${samePr ? ` — its ${moved.join(" and ")} moved since this review's capture` : ""}; this retained review predates it; re-run the review to replace it.`,
    );
  }
  const selected = new Set(selection.kind === "subset" ? selection.indexes : []);
  const allSelected = selection.kind === "all";
  if (review.findings.length === 0) {
    lines.push("Findings: none survived validation, adjudication, and the mode policy.");
  } else {
    lines.push(`Findings (${review.findings.length}, numbered as reported):`);
    review.findings.forEach((finding, index) => {
      const position = index + 1;
      const mark = allSelected || selected.has(position) ? "selected" : "not selected";
      const location = finding.file ? ` — ${inspectText(finding.file)}${finding.line ? `:${finding.line}` : ""}` : "";
      lines.push(`${position}. [${finding.severity}] ${inspectText(finding.title)} [${inspectText(finding.lane)}]${location} — ${mark}`);
    });
  }
  lines.push(
    "Rendered from the retained in-session result: no model calls, no GitHub access.",
    "Publication posts the selected findings when authorized (--comment / autoPostReviews);",
    "/z-pr-review select re-settles the selection.",
  );
  return lines.join("\n");
}
