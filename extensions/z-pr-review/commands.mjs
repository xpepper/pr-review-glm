// Pure command-surface logic: argument parsing and text rendering, free of any
// runtime dependency so it stays unit-testable. extension.mjs wires these to
// joinSession and the config store.

// /z-pr-review review-invocation grammar (spec "Review pipeline"):
//   <PR number> [--quick|--balanced|--full|--deep] [--comment|--no-comment]
//   [--all] [--include-closed|--include-drafts] [--capture-only]
// Parsing is total — the whole grammar is accepted here even before every flag
// has an implementation; extension.mjs decides what can actually run today.
const MODE_FLAGS = new Map([
  ["--quick", "quick"],
  ["--balanced", "balanced"],
  ["--full", "full"],
  ["--deep", "deep"],
]);

export function parseReviewArgs(args) {
  const trimmed = args.trim();
  if (trimmed === "" || trimmed === "status") return { kind: "status" };
  if (trimmed === "help" || trimmed === "--help") return { kind: "help" };
  const tokens = trimmed.split(/\s+/);
  if (!/^[1-9][0-9]*$/.test(tokens[0])) {
    return reviewUsageError(
      `"${trimmed}" is not a review invocation. Give a PR number: /z-pr-review <PR number> [flags]`,
    );
  }
  const number = Number(tokens[0]);
  const flags = {
    captureOnly: false,
    includeDrafts: false,
    includeClosed: false,
    mode: null,
    comment: null,
    all: false,
  };
  const seen = new Set();
  for (const token of tokens.slice(1)) {
    if (seen.has(token)) {
      return reviewUsageError(`Flag "${token}" appears twice.`);
    }
    if (token === "--capture-only") flags.captureOnly = true;
    else if (token === "--include-drafts") flags.includeDrafts = true;
    else if (token === "--include-closed") flags.includeClosed = true;
    else if (token === "--all") flags.all = true;
    else if (token === "--comment" || token === "--no-comment") {
      if (flags.comment !== null) {
        return reviewUsageError("Choose either --comment or --no-comment, not both.");
      }
      flags.comment = token === "--comment";
    } else if (MODE_FLAGS.has(token)) {
      if (flags.mode !== null) {
        return reviewUsageError(`Only one mode flag is allowed ("${token}" after --${flags.mode}).`);
      }
      flags.mode = MODE_FLAGS.get(token);
    } else {
      return reviewUsageError(`Unknown flag "${token}".`);
    }
    seen.add(token);
  }
  // --capture-only stops before lanes, selection, and publication; flags that
  // only affect those stages are inert there and rejected, not ignored.
  if (flags.captureOnly) {
    const inert =
      flags.mode !== null
        ? `--${flags.mode}`
        : flags.comment === true
          ? "--comment"
          : flags.comment === false
            ? "--no-comment"
            : flags.all
              ? "--all"
              : null;
    if (inert !== null) {
      return reviewUsageError(
        `"${inert}" has no effect with --capture-only (no lanes, selection, or publication run); drop it.`,
      );
    }
  }
  return { kind: "review", number, flags };
}

function reviewUsageError(detail) {
  return {
    kind: "error",
    message: `${detail}.\nUsage: /z-pr-review [status|help] | /z-pr-review <PR number> [flags]. Run /z-pr-review help.`,
  };
}

export function renderStatus(lastCapture = null) {
  const lines = [
    "z-pr-review — parallel tiered PR review for GitHub Copilot CLI (port of pi-pr-review)",
    "",
    "Implemented today:",
    "- /z-pr-review status | help — this capability boundary. These commands make no model calls.",
    "- /z-pr-review N --capture-only — read-only PR capture via gh (metadata, base/head, diff).",
    "  No model calls.",
    "- /z-pr-review N [--quick|--balanced|--full|--deep] [--no-comment] — capture plus a",
    "  concurrent tiered lane batch over the diff (light/medium/heavy models + one fallback",
    "  each from config; owned Copilot SDK child runtimes under attempt/batch/total budgets);",
    "  findings rendered in-chat. Publication never runs in v1 without a future gate (I7).",
    "- /z-pr-review-config — inspect and edit personal configuration.",
    "",
    "Not implemented yet (ROADMAP order):",
    "- I5: deterministic validation and adjudication",
    "- I6: finding selection",
    "- I7: gated COMMENT publication",
    "- I8: hardening (large diffs, telemetry)",
    "",
    "Configuration lives outside the repository and is validated as a unit; see /z-pr-review-config.",
  ];
  if (lastCapture !== null) {
    lines.push(
      "",
      "Last capture (this session):",
      `- PR #${lastCapture.number} ${lastCapture.repo} — ${lastCapture.state}` +
        `${lastCapture.isDraft ? " (draft)" : ""}, head ${shortOid(lastCapture.headOid)} -> ` +
        `base ${shortOid(lastCapture.baseOid)}, ${lastCapture.diffBytes.toLocaleString("en-US")} byte diff`,
      `- File: ${lastCapture.capturePath} (0600)`,
    );
  }
  return lines.join("\n");
}

export function renderCapture(summary) {
  return [
    `Captured PR #${summary.number} — "${summary.title}" (${summary.state}${summary.isDraft ? ", draft" : ""})`,
    `Repository: ${summary.repo} (binding frozen at capture time)`,
    `Head: ${summary.headRefName} @ ${shortOid(summary.headOid)} -> Base: ${summary.baseRefName} @ ${shortOid(summary.baseOid)}`,
    `Author: ${summary.author ?? "(unknown)"}`,
    `Diff: ${summary.diffBytes.toLocaleString("en-US")} bytes`,
    `Capture file: ${summary.capturePath} (0600)`,
    `Captured at: ${summary.capturedAt}`,
    "No model calls were made: capture is pure code over gh output.",
  ].join("\n");
}

function shortOid(oid) {
  return oid.slice(0, 7);
}

// Model text is flattened before interpolation so a finding title/detail can
// never inject lines, fences, or fake machine blocks into the report; inside
// the machine block, backticks are also neutralized (JSON.stringify does not
// escape them, so a stray ``` could terminate the fence early).
function singleLine(text) {
  return String(text).split(/\r?\n/).join(" ");
}

function machineText(text) {
  return singleLine(text).replace(/`+/g, "'");
}

// In-chat review report for a lane batch (I4: quick/balanced/full/deep
// topologies). The trailing fenced block is the machine-readable summary the
// dev-loop's dogfood review maps into its verdict contract; the verdict itself
// is computed by loop code, not by any model (spec: model text never decides
// publication or merges). `batch` is runLaneBatch's result with a modelLabel
// added per lane by the caller (code-owned, from config).
export function renderReview(capture, batch) {
  const findings = batch.lanes.flatMap((lane) =>
    lane.status === "complete" ? lane.findings.map((finding) => ({ ...finding, lane: lane.laneId })) : [],
  );
  const dropped = batch.lanes.reduce((total, lane) => total + (lane.status === "complete" ? lane.dropped.length : 0), 0);
  const lines = [
    `Reviewed PR #${capture.number} — "${capture.title}" (${capture.repo})`,
    `Mode: ${batch.mode} — ${batch.lanes.length} lane(s), ${Math.round(batch.elapsedMs / 100) / 10}s`,
  ];
  for (const lane of batch.lanes) {
    const tail = lane.status === "complete" ? `complete — ${lane.findings.length} finding(s)` : `FAILED (${lane.reason})`;
    lines.push(`- ${lane.laneId} (${lane.tier}, ${lane.modelLabel}): ${tail}`);
  }
  if (batch.status === "complete") {
    if (findings.length === 0) {
      lines.push("Findings: none. (All lanes completed and reported nothing.)");
    } else {
      lines.push(`Findings: ${findings.length}`);
      for (const finding of findings) {
        const location = finding.file ? ` — ${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
        lines.push(`- [${finding.severity}] ${singleLine(finding.title)} [${finding.lane}]${location}`);
        if (finding.detail) {
          lines.push(`  ${singleLine(finding.detail)}`);
        }
      }
    }
    if (dropped > 0) {
      lines.push(`Dropped ${dropped} malformed candidate finding(s) — disclosed, not hidden.`);
    }
  } else {
    lines.push(
      `Coverage: ${batch.lanes.filter((lane) => lane.status === "complete").length}/${batch.lanes.length} lane(s) completed — ${batch.reason}`,
    );
    lines.push("This is an incomplete review, never a clean one; failed lanes' findings are not claimed.");
  }
  lines.push(
    "",
    "```z-pr-review-findings",
    JSON.stringify({
      status: batch.status,
      reason: batch.status === "complete" ? undefined : batch.reason,
      mode: batch.mode,
      findings: findings.map((finding) => ({
        severity: finding.severity,
        title: machineText(finding.title),
        file: finding.file === undefined ? undefined : machineText(finding.file),
        line: finding.line,
        detail: finding.detail === undefined ? undefined : machineText(finding.detail),
        lane: machineText(finding.lane),
      })),
      dropped,
      lanes: batch.lanes.map((lane) => ({
        id: lane.laneId,
        tier: lane.tier,
        status: lane.status,
        findings: lane.status === "complete" ? lane.findings.length : 0,
      })),
    }),
    "```",
  );
  return lines.join("\n");
}

export function renderHelp() {
  return [
    "/z-pr-review — parallel tiered PR review (under construction)",
    "",
    "Usage:",
    "  /z-pr-review status                     Show the capability boundary (default)",
    "  /z-pr-review help                       Show this help",
    "  /z-pr-review <N> --capture-only         Capture PR N read-only (metadata + diff via gh)",
    "                                           [--include-drafts] [--include-closed]",
    "  /z-pr-review <N> [mode] [--no-comment]  Review PR N: capture, then a concurrent tiered",
    "                                           lane batch; findings in-chat.",
    "                                           mode: --quick|--balanced|--full|--deep",
    "                                           (default: config defaultMode, balanced).",
    "                                           [--include-drafts] [--include-closed]",
    "",
    "Finding selection (--all) and COMMENT publication (--comment) arrive with increments",
    "I6 and I7.",
    "Configuration: /z-pr-review-config [show] | key=value ... | unset key ...",
  ].join("\n");
}

const SET_TOKEN = /^([^=\s]+)=(.*)$/;

export function parseConfigArgs(args) {
  const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens[0] === "show") {
    if (tokens.length > 1) {
      return usageError(`"show" takes no further arguments`);
    }
    return { kind: "show" };
  }
  if (tokens[0] === "help" || tokens[0] === "--help") {
    if (tokens.length > 1) {
      return usageError(`"help" takes no further arguments`);
    }
    return { kind: "help" };
  }
  if (tokens[0] === "unset") {
    const keys = tokens.slice(1);
    if (keys.length === 0) {
      return usageError('"unset" needs at least one key');
    }
    return { kind: "unset", keys };
  }
  const entries = [];
  for (const token of tokens) {
    const match = SET_TOKEN.exec(token);
    if (!match) {
      return usageError(`"${token}" is not a key=value pair`);
    }
    if (match[2].length === 0) {
      return usageError(`"${match[1]}" has an empty value`);
    }
    entries.push([match[1], match[2]]);
  }
  return { kind: "set", entries };
}

function usageError(detail) {
  return {
    kind: "error",
    message: `${detail}.\nUsage: /z-pr-review-config [show] | key=value ... | unset key ...`,
  };
}

export function renderConfigShow(store) {
  const config = store.get();
  const lines = [
    "z-pr-review configuration",
    `File: ${store.path}`,
    `Source: ${store.source}${store.source === "defaults" ? " (no valid file yet; defaults are active)" : ""}`,
  ];
  for (const warning of store.warnings) {
    lines.push(`Warning: ${warning}`);
  }
  lines.push(
    "",
    `schemaVersion: ${config.schemaVersion}`,
    `tiers.light.model: ${formatModel(config.tiers.light.model)}`,
    `tiers.light.effort: ${config.tiers.light.effort}`,
    `tiers.light.fallback: ${formatFallback(config.tiers.light.fallback)}`,
    `tiers.medium.model: ${formatModel(config.tiers.medium.model)}`,
    `tiers.medium.effort: ${config.tiers.medium.effort}`,
    `tiers.medium.fallback: ${formatFallback(config.tiers.medium.fallback)}`,
    `tiers.heavy.model: ${formatModel(config.tiers.heavy.model)}`,
    `tiers.heavy.effort: ${config.tiers.heavy.effort}`,
    `tiers.heavy.fallback: ${formatFallback(config.tiers.heavy.fallback)}`,
    `defaultMode: ${config.defaultMode}`,
    `autoPostReviews: ${config.autoPostReviews}`,
    `deadlines.attemptMs.light: ${config.deadlines.attemptMs.light}`,
    `deadlines.attemptMs.medium: ${config.deadlines.attemptMs.medium}`,
    `deadlines.attemptMs.heavy: ${config.deadlines.attemptMs.heavy}`,
    `deadlines.fallbackMs: ${config.deadlines.fallbackMs}`,
    `deadlines.batchMs: ${config.deadlines.batchMs}`,
    `deadlines.adjudicationMs: ${config.deadlines.adjudicationMs}`,
    `deadlines.totalMs: ${config.deadlines.totalMs}`,
  );
  return lines.join("\n");
}

function formatModel(model) {
  return model === null ? "null (session model)" : model;
}

function formatFallback(fallback) {
  return fallback === undefined ? "(unset)" : fallback;
}

export function renderConfigHelp(store) {
  return [
    "/z-pr-review-config — inspect or change z-pr-review configuration",
    "",
    "Usage:",
    "  /z-pr-review-config                          Show the current configuration",
    "  /z-pr-review-config show                     Same as above",
    "  /z-pr-review-config key=value [key=value …]  Set values (validated as a unit)",
    "  /z-pr-review-config unset key [key …]        Reset keys to their defaults",
    "",
    `File: ${store.path}`,
    "Settable keys: tiers.{light,medium,heavy}.{model,effort,fallback}, defaultMode,",
    "autoPostReviews, deadlines.{attemptMs.{light,medium,heavy},fallbackMs,batchMs,",
    "adjudicationMs,totalMs}.",
    "Values: true/false, integers (milliseconds), or strings (model ids, efforts).",
    "A tier model of null uses the session model at review time; only",
    "`unset tiers.<tier>.model` restores that null (set always takes a literal id).",
  ].join("\n");
}
