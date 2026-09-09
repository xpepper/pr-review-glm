// Pure command-surface logic: argument parsing and text rendering, free of any
// runtime dependency so it stays unit-testable. extension.mjs wires these to
// joinSession and the config store.

// /pr-review review-invocation grammar (spec "Review pipeline"):
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
      `"${trimmed}" is not a review invocation. Give a PR number: /pr-review <PR number> [flags]`,
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
    message: `${detail}.\nUsage: /pr-review [status|help] | /pr-review <PR number> [flags]. Run /pr-review help.`,
  };
}

export function renderStatus(lastCapture = null) {
  const lines = [
    "pr-review-glm — parallel tiered PR review for GitHub Copilot CLI (port of pi-pr-review)",
    "",
    "Implemented today:",
    "- /pr-review status | help — this capability boundary. These commands make no model calls.",
    "- /pr-review N --capture-only — read-only PR capture via gh (metadata, base/head, diff).",
    "  No model calls.",
    "- /pr-review-config — inspect and edit personal configuration.",
    "",
    "Not implemented yet (ROADMAP order):",
    "- I3: first review lane and in-chat findings (dogfood entry point)",
    "- I4: mode topologies and model tiers",
    "- I5: deterministic validation and adjudication",
    "- I6: finding selection",
    "- I7: gated COMMENT publication",
    "- I8: hardening (large diffs, telemetry)",
    "",
    "Configuration lives outside the repository and is validated as a unit; see /pr-review-config.",
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

export function renderHelp() {
  return [
    "/pr-review — parallel tiered PR review (under construction)",
    "",
    "Usage:",
    "  /pr-review status                     Show the capability boundary (default)",
    "  /pr-review help                       Show this help",
    "  /pr-review <N> --capture-only         Capture PR N read-only (metadata + diff via gh)",
    "                                         [--include-drafts] [--include-closed]",
    "",
    "Reviews (lanes, findings, publication) are not implemented yet; they arrive with",
    "increment I3 onward. Full review flags: [--quick|--balanced|--full|--deep]",
    "[--comment|--no-comment] [--all] — accepted later, not today.",
    "Configuration: /pr-review-config [show] | key=value ... | unset key ...",
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
    message: `${detail}.\nUsage: /pr-review-config [show] | key=value ... | unset key ...`,
  };
}

export function renderConfigShow(store) {
  const config = store.get();
  const lines = [
    "pr-review-glm configuration",
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
    "/pr-review-config — inspect or change pr-review-glm configuration",
    "",
    "Usage:",
    "  /pr-review-config                          Show the current configuration",
    "  /pr-review-config show                     Same as above",
    "  /pr-review-config key=value [key=value …]  Set values (validated as a unit)",
    "  /pr-review-config unset key [key …]        Reset keys to their defaults",
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
