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
  const indexes = [];
  for (const part of text.split(",")) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (range === null) {
      return { kind: "error", message: `"${part}" is not a number or range.` };
    }
    const start = Number(range[1]);
    const end = range[2] === undefined ? start : Number(range[2]);
    if (end < start) {
      return { kind: "error", message: `Range ${part} is descending — write the smaller number first.` };
    }
    for (let index = start; index <= end; index++) indexes.push(index);
  }
  if (new Set(indexes).size !== indexes.length) {
    return { kind: "error", message: "The selection names a finding more than once." };
  }
  if (total === 0) {
    return { kind: "error", message: "The retained review has no findings — nothing to select." };
  }
  const outOfRange = indexes.filter((index) => index < 1 || index > total);
  if (outOfRange.length > 0) {
    const shown = [...new Set(outOfRange)].join(", ");
    return { kind: "error", message: `Finding${outOfRange.length === 1 ? "" : "s"} ${shown} do not exist — the retained review has ${total} finding${total === 1 ? "" : "s"} (1–${total}).` };
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

// Renders the confirmation after /z-pr-review select settles a selection.
export function renderSelectResult(capture, selection) {
  return [
    `Selection for PR #${capture.number} (${capture.repo}): ${describeSelection(selection)}`,
    selection.kind === "none"
      ? "No findings selected — nothing will be published for this review (publication gates arrive with I7)."
      : "The retained result is up to date; /z-pr-review inspect shows it without model calls or GitHub access.",
  ].join("\n");
}

// Renders the retained settled result. Pure text over the in-session state:
// no model calls, no gh, no network — the "inspectable without inference"
// deliverable of I6.
export function renderInspect(retained) {
  const { capture, review, selection } = retained;
  const lines = [
    `Retained review — PR #${capture.number} "${capture.title}" (${capture.repo})`,
    `Head: ${capture.headRefName} @ ${capture.headOid.slice(0, 7)} -> Base: ${capture.baseRefName} @ ${capture.baseOid.slice(0, 7)} (binding frozen at capture time)`,
    `Mode: ${review.mode} — status: ${review.status}${review.reason !== undefined ? ` (${review.reason})` : ""}`,
    `Coverage: ${review.lanes.filter((lane) => lane.status === "complete").length}/${review.lanes.length} lane${review.lanes.length === 1 ? "" : "s"} completed`,
    `Selection: ${describeSelection(selection)}`,
  ];
  const selected = new Set(selection.kind === "subset" ? selection.indexes : []);
  const allSelected = selection.kind === "all";
  if (review.findings.length === 0) {
    lines.push("Findings: none survived validation, adjudication, and the mode policy.");
  } else {
    lines.push(`Findings (${review.findings.length}, numbered as reported):`);
    review.findings.forEach((finding, index) => {
      const position = index + 1;
      const mark = allSelected || selected.has(position) ? "selected" : "not selected";
      const location = finding.file ? ` — ${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
      lines.push(`${position}. [${finding.severity}] ${String(finding.title).split(/\r?\n/).join(" ")} [${finding.lane}]${location} — ${mark}`);
    });
  }
  lines.push(
    "Rendered from the retained in-session result: no model calls, no GitHub access.",
    "Publication of the selected findings arrives with I7; /z-pr-review select re-settles the selection.",
  );
  return lines.join("\n");
}
