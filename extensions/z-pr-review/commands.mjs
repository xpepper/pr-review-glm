// Pure command-surface logic: argument parsing and text rendering, free of any
// runtime dependency so it stays unit-testable. extension.mjs wires these to
// joinSession and the config store.

// /z-pr-review review-invocation grammar (spec "Review pipeline"):
//   <PR number> [--quick|--balanced|--full|--deep] [--comment|--no-comment]
//   [--all] [--include-closed|--include-drafts] [--capture-only]
// plus the I6 selection/retention subcommands `inspect` and
//   select all|none|<numbers, e.g. 1,3-5>
// Parsing is total for the grammar shapes; whether a spec names findings that
// exist is checked later against the retained review (select.mjs).
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
  if (trimmed === "inspect") return { kind: "inspect" };
  const tokens = trimmed.split(/\s+/);
  if (tokens[0] === "select") {
    if (tokens.length === 1) {
      return reviewUsageError('"select" needs a selection: all, none, or finding numbers like 1,3-5.');
    }
    if (tokens.length > 2) {
      return reviewUsageError(`"select" takes one selection — "${tokens.slice(1).join(" ")}" reads as several.`);
    }
    return { kind: "select", spec: tokens[1] };
  }
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
    message: `${detail}.\nUsage: /z-pr-review [status|help|inspect] | /z-pr-review select all|none|1,3-5 | /z-pr-review <PR number> [flags]. Run /z-pr-review help.`,
  };
}

export function renderStatus(lastCapture = null, version = null) {
  const lines = [
    "z-pr-review — parallel tiered PR review for GitHub Copilot CLI (port of pi-pr-review)",
    `Version: ${version ?? "(unknown — plugin.json missing, unreadable, or has no version field)"}`,
    "",
    "Implemented today:",
    "- /z-pr-review status | help — this capability boundary. These commands make no model calls.",
    "- /z-pr-review N --capture-only — read-only PR capture via gh (metadata, base/head, diff).",
    "  No model calls.",
    "- /z-pr-review N [--quick|--balanced|--full|--deep] [--no-comment] — capture plus a",
    "  concurrent tiered lane batch over the diff (light/medium/heavy models + one fallback",
    "  each from config; owned Copilot SDK child runtimes under attempt/batch/total budgets).",
    "  Candidates are host-validated against the diff (anchors, severity ladder, blocking",
    "  evidence), merged by one isolated adjudicator call, deduplicated, and filtered by the",
    "  per-mode findings policy — all enforced in code. Large diffs (≥200 KB) switch to",
    "  file-backed transport: per-file diff sections on disk, a changed-file manifest with",
    "  required read ranges in each lane prompt, and read completeness enforced from tool",
    "  events. Per-lane model-call/credit telemetry is collected from runtime events and",
    "  reported (informational only).",
    "- /z-pr-review select all|none|1,3-5 — settle a selection over the retained review's",
    "  findings (numbered as reported); --all on the review settles it up front.",
    "- /z-pr-review inspect — the retained settled result, with no model calls and no",
    "  GitHub access.",
    "- /z-pr-review N --comment — gated COMMENT publication of the selected findings",
    "  (or config autoPostReviews): one POST, at most 50 inline anchors re-validated",
    "  against the PR's changed-file hunks (the rest go to body notes), draft/closed/",
    "  self-author/stale gates, and an idempotency marker. Publication authority is",
    "  code-owned, never model text.",
    "- /z-pr-review-config — inspect and edit personal configuration.",
    "- Custom review roles and modes (schemaVersion 2 config): user-defined lanes",
    "  (prompt + tier, optional model/effort overrides) composed into custom modes;",
    "  edited directly in the config file, shown via /z-pr-review-config show.",
    "",
    "Not implemented yet (ROADMAP order):",
    "- V2: ground-testing feedback round (dogfood-driven fixes) before the 1.0.0 release",
    "  decision.",
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

// I8: one compact tail for a lane's runtime telemetry. Every value here is
// host-computed from child-session events (counts/sums of numbers) — never
// model text — so it renders without the finding-text sanitization passes.
function telemetryTail(telemetry) {
  if (telemetry === null || typeof telemetry !== "object" || typeof telemetry.calls !== "number") {
    return null;
  }
  const parts = [`${telemetry.calls} model call${telemetry.calls === 1 ? "" : "s"}`];
  if (Number.isFinite(telemetry.dispatchMs) && telemetry.dispatchMs > 0) {
    parts.push(`${Math.round(telemetry.dispatchMs / 100) / 10}s model time`);
  }
  if (Number.isFinite(telemetry.usageNanoAiu) && telemetry.usageNanoAiu > 0) {
    parts.push(
      telemetry.usageNanoAiu >= 1_000_000
        ? `${(telemetry.usageNanoAiu / 1e9).toFixed(2)} AIU`
        : `${telemetry.usageNanoAiu.toLocaleString("en-US")} nano-AIU`,
    );
  }
  return parts.join(", ");
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

// In-chat review report (I5: validation, adjudication, and policy now assemble
// the final findings host-side; the lanes section still reports raw coverage).
// The trailing fenced block is the machine-readable summary the dev-loop's
// dogfood review maps into its verdict contract; its field shape is a
// loop↔plugin protocol surface — values change with the assembled findings, the
// keys must not. The verdict itself is computed by loop code, not by any model
// (spec: model text never decides publication or merges). `review` is
// assembleReview's result with a modelLabel added per lane by the caller
// (code-owned, from config).
export function renderReview(capture, review) {
  const findings = review.findings;
  const { shaping = 0, validation = 0, adjudication: adjudicationDrops = 0, policy = 0 } = review.drops ?? {};
  const dropped = shaping + validation + adjudicationDrops + policy;
  const lines = [
    `Reviewed PR #${capture.number} — "${capture.title}" (${capture.repo})`,
    `Mode: ${review.mode} — ${review.lanes.length} lane${review.lanes.length === 1 ? "" : "s"}, ${Math.round(review.elapsedMs / 100) / 10}s`,
  ];
  if (review.transport?.mode === "file-backed") {
    lines.push(
      `Transport: file-backed — ${review.transport.diffBytes.toLocaleString("en-US")}-byte diff across ${review.transport.fileCount} file${review.transport.fileCount === 1 ? "" : "s"}; lanes read per-file diff sections from disk (required reads enforced from tool events).`,
    );
  }
  for (const lane of review.lanes) {
    const findingsWord = `${lane.findings.length} finding${lane.findings.length === 1 ? "" : "s"}`;
    const tail = lane.status === "complete" ? `complete — ${findingsWord}` : `FAILED (${lane.reason})`;
    const usage = telemetryTail(lane.telemetry);
    lines.push(`- ${lane.laneId} (${lane.tier}, ${lane.modelLabel}): ${tail}${usage ? ` [${usage}]` : ""}`);
  }
  const adjudication = review.adjudication ?? { status: "skipped", reason: "not assembled" };
  if (adjudication.status === "complete") {
    lines.push(`- adjudication (heavy): complete — merged to ${adjudication.merged} finding${adjudication.merged === 1 ? "" : "s"}`);
  } else if (adjudication.status === "skipped") {
    lines.push(`- adjudication (heavy): skipped — ${adjudication.reason ?? "no validated candidates"}`);
  } else {
    lines.push(`- adjudication (heavy): FAILED (${adjudication.reason}) — degraded: validated candidates reported unmerged`);
  }
  if (findings.length === 0) {
    lines.push("Findings: none. (Nothing survived host validation, adjudication, and the mode policy.)");
  } else {
    lines.push(`Findings: ${findings.length} (validated against the diff${adjudication.status === "complete" ? ", adjudicated" : ""})`);
    findings.forEach((finding, index) => {
      const location = finding.file ? ` — ${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
      lines.push(`${index + 1}. [${finding.severity}] ${singleLine(finding.title)} [${finding.lane}]${location}`);
      if (finding.detail) {
        lines.push(`  ${singleLine(finding.detail)}`);
      }
    });
    // I6: the numbers are the selection surface — /z-pr-review select names
    // them; the retained result holds the default selection (all) until then.
    lines.push(
      `Selection: all ${findings.length} finding${findings.length === 1 ? " is" : "s are"} retained as the default selection.`,
      "Settle it with /z-pr-review select all|none|<numbers, e.g. 1,3-5> — /z-pr-review inspect shows the retained",
      "settled result with no model calls and no GitHub access.",
    );
  }
  if (dropped > 0) {
    const parts = [
      shaping > 0 ? `${shaping} malformed` : null,
      validation > 0 ? `${validation} failing host validation` : null,
      adjudicationDrops > 0 ? `${adjudicationDrops} malformed in adjudication` : null,
      policy > 0 ? `${policy} below the ${review.mode} mode policy` : null,
    ].filter(Boolean);
    lines.push(`Dropped ${dropped} candidate finding${dropped === 1 ? "" : "s"} (${parts.join(", ")}) — disclosed, not hidden.`);
  }
  if (review.status !== "complete") {
    lines.push(
      `Coverage: ${review.lanes.filter((lane) => lane.status === "complete").length}/${review.lanes.length} lane${review.lanes.length === 1 ? "" : "s"} completed — ${review.reason}`,
    );
    lines.push("This is an incomplete review, never a clean one; failed lanes' findings are not claimed.");
  }
  lines.push(
    "",
    "```z-pr-review-findings",
    JSON.stringify({
      status: review.status,
      reason: review.status === "complete" ? undefined : review.reason,
      mode: review.mode,
      // I8 additions (additive protocol keys): the transport the review ran
      // under and each lane's host-computed runtime telemetry — informational
      // only, never a gate input on either side of the contract.
      ...(review.transport?.mode === "file-backed"
        ? { transport: { mode: "file-backed", files: review.transport.fileCount, diffBytes: review.transport.diffBytes } }
        : {}),
      findings: findings.map((finding) => ({
        severity: finding.severity,
        title: machineText(finding.title),
        file: finding.file === undefined ? undefined : machineText(finding.file),
        line: finding.line,
        detail: finding.detail === undefined ? undefined : machineText(finding.detail),
        lane: machineText(finding.lane),
      })),
      dropped,
      lanes: review.lanes.map((lane) => ({
        id: lane.laneId,
        tier: lane.tier,
        status: lane.status,
        findings: lane.status === "complete" ? lane.findings.length : 0,
        ...(lane.telemetry
          ? {
              telemetry: {
                calls: lane.telemetry.calls,
                dispatchMs: lane.telemetry.dispatchMs,
                usageNanoAiu: lane.telemetry.usageNanoAiu ?? 0,
              },
            }
          : {}),
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
    "  /z-pr-review inspect                    Show the retained settled result (no model",
    "                                           calls, no GitHub access)",
    "  /z-pr-review select all|none|1,3-5      Settle a selection over the retained review's",
    "                                           findings (numbered as reported)",
    "  /z-pr-review <N> --capture-only         Capture PR N read-only (metadata + diff via gh)",
    "                                           [--include-drafts] [--include-closed]",
    "  /z-pr-review <N> [mode] [--comment|     Review PR N: capture, then a concurrent tiered",
    "                           --no-comment]  lane batch; candidates host-validated against",
    "                                           the diff, merged by one adjudicator call,",
    "                                           deduped, filtered by the mode policy; in-chat.",
    "                                           mode: --quick|--balanced|--full|--deep",
    "                                           (default: config defaultMode, balanced).",
    "                                           [--include-drafts] [--include-closed]",
    "                                           [--all: settle the selection to every finding",
    "                                           at review time — the default selection is all",
    "                                           findings anyway; --all marks it settled]",
    "",
    "The retained result lives for the session; selection and inspect are pure code over it.",
    "Publication is gated: /z-pr-review <N> --comment (or config autoPostReviews, unless",
    "--no-comment) posts the selected findings as one COMMENT review after the report.",
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
    ...renderRoles(config.roles),
    ...renderModes(config.modes),
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

// Roles and modes are edited directly in the config file (multi-line prompts
// don't fit the key=value grammar), so `show` is their read surface: one line
// per role with the tier/overrides and a one-line prompt excerpt, and the
// mode compositions. Newlines inside a prompt excerpt are flattened so a
// prompt can never forge extra config lines.
function renderRoles(roles) {
  const entries = Object.entries(roles ?? {});
  if (entries.length === 0) return ["roles: (none — standard topologies only)"];
  return [
    `roles: ${entries.length} defined`,
    ...entries.map(([id, role]) => {
      const overrides = [
        role.model === undefined ? null : `model ${formatModel(role.model)}`,
        role.effort === undefined ? null : `effort ${role.effort}`,
      ].filter(Boolean);
      const tail = overrides.length > 0 ? `, ${overrides.join(", ")}` : "";
      const excerpt = singleLine(role.prompt).slice(0, 72);
      return `- ${id} (${role.tier}${tail}): "${excerpt}"`;
    }),
  ];
}

function renderModes(modes) {
  const entries = Object.entries(modes ?? {});
  if (entries.length === 0) return ["modes: (none — standard modes apply)"];
  return [
    `modes: ${entries.length} defined (override/compose standard modes)`,
    ...entries.map(([name, laneIds]) => `- ${name}: ${laneIds.join(" -> ")}`),
  ];
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
    "Custom review roles and modes are edited directly in the config file",
    "(multi-line prompts don't fit key=value): roles.<id> = {prompt, tier,",
    "model?, effort?}; modes.<name> = ordered array of built-in lane ids and/or",
    "role ids (a standard mode name there overrides that mode). Set",
    "defaultMode to a custom mode to select it; mode flags stay standard.",
  ].join("\n");
}
