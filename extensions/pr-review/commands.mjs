// Pure command-surface logic: argument parsing and text rendering, free of any
// runtime dependency so it stays unit-testable. extension.mjs wires these to
// joinSession and the config store.

export function parseReviewArgs(args) {
  const trimmed = args.trim();
  if (trimmed === "" || trimmed === "status") return { kind: "status" };
  if (trimmed === "help" || trimmed === "--help") return { kind: "help" };
  return {
    kind: "error",
    message:
      `"${trimmed}" is not implemented yet. Only "status" and "help" exist today; ` +
      "reviews arrive with later increments. Run /pr-review help.",
  };
}

export function renderStatus() {
  return [
    "pr-review-glm — parallel tiered PR review for GitHub Copilot CLI (port of pi-pr-review)",
    "",
    "Implemented today:",
    "- /pr-review status | help — this capability boundary. These commands make no model calls.",
    "- /pr-review-config — inspect and edit personal configuration.",
    "",
    "Not implemented yet (ROADMAP order):",
    "- I2: read-only PR capture (--capture-only)",
    "- I3: first review lane and in-chat findings (dogfood entry point)",
    "- I4: mode topologies and model tiers",
    "- I5: deterministic validation and adjudication",
    "- I6: finding selection",
    "- I7: gated COMMENT publication",
    "- I8: hardening (large diffs, telemetry)",
    "",
    "Configuration lives outside the repository and is validated as a unit; see /pr-review-config.",
  ].join("\n");
}

export function renderHelp() {
  return [
    "/pr-review — parallel tiered PR review (under construction)",
    "",
    "Usage:",
    "  /pr-review status    Show the capability boundary (default)",
    "  /pr-review help      Show this help",
    "",
    "Reviews are not implemented yet; /pr-review status lists what exists today.",
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
