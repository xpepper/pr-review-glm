// M1 no-inference smoke script: marketplace consistency. The public marketplace
// entry for z-pr-review (xpepper/copilot-plugins) must exist, point at THIS
// repository at the repo root, carry the same version as plugin.json, and pin
// the matching release tag. This is the gate-enforced release discipline: every
// plugin.json bump also bumps the marketplace entry, or the next assessment
// fails here. Pure script smoke (no Copilot SDK), like smoke-l1.mjs.
//
// Usage:
//   node tests/smoke-m1.mjs
// Optional env: ZPR_MARKETPLACE_MANIFEST_URL (override manifest URL),
// GH_TOKEN (raises the GitHub API rate limit; works unauthenticated too).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MARKETPLACE_REPO = "xpepper/copilot-plugins";
const PLUGIN_NAME = "z-pr-review";
const PLUGIN_REPO = "xpepper/pr-review-glm";
// The contents API with the raw media type serves the manifest FRESH; the
// raw.githubusercontent CDN can lag a just-pushed entry bump by ~5 minutes,
// which would fail the discipline gate spuriously (verified 2026-09-13).
const DEFAULT_MANIFEST_URL =
  "https://api.github.com/repos/xpepper/copilot-plugins/contents/.github/plugin/marketplace.json";

// Pure consistency rules, exported for unit tests (tests/marketplace.test.mjs).
// Every problem line names the marketplace repo so a failing gate points at the
// place to fix, not just the symptom.
//
// Deliberate scope (dogfood P2, dispositioned design-inherent 2026-09-13): the
// rules verify MANIFEST consistency only — the pinned tag v{version} cannot be
// existence-checked here because it is pushed at the increment merge (never from
// a branch), so pre-merge assessments would always fail it. Tag existence is
// enforced by the merge-time tagging plus the post-merge marketplace install
// verification.
export function checkMarketplaceConsistency({ manifest, pluginVersion }) {
  const problems = [];
  const plugins = Array.isArray(manifest?.plugins) ? manifest.plugins : null;
  if (!plugins) {
    return { problems: [`marketplace ${MARKETPLACE_REPO} manifest has no plugins[] array`] };
  }
  const entry = plugins.find((p) => p?.name === PLUGIN_NAME);
  if (!entry) {
    return { problems: [`marketplace ${MARKETPLACE_REPO} has no ${PLUGIN_NAME} entry`] };
  }
  if (entry.source?.source !== "github") {
    problems.push(
      `marketplace ${MARKETPLACE_REPO} entry ${PLUGIN_NAME} must use the github source form, found ${JSON.stringify(entry.source?.source)}`,
    );
  }
  if (entry.source?.repo !== PLUGIN_REPO) {
    problems.push(
      `marketplace ${MARKETPLACE_REPO} entry ${PLUGIN_NAME} must point at ${PLUGIN_REPO}, found ${String(entry.source?.repo)}`,
    );
  }
  if (entry.source?.path !== ".") {
    problems.push(
      `marketplace ${MARKETPLACE_REPO} entry ${PLUGIN_NAME} must use the repo root (path "."), found ${JSON.stringify(entry.source?.path)}`,
    );
  }
  if (entry.version !== pluginVersion) {
    problems.push(
      `marketplace ${MARKETPLACE_REPO} entry ${PLUGIN_NAME} version ${String(entry.version)} != plugin.json ${pluginVersion} — bump the entry (and its ref tag) in the same increment; one-line direct push, disclosed in the increment PR`,
    );
  }
  if (entry.source?.ref !== `v${pluginVersion}`) {
    problems.push(
      `marketplace ${MARKETPLACE_REPO} entry ${PLUGIN_NAME} must pin source.ref to v${pluginVersion}, found ${JSON.stringify(entry.source?.ref)}`,
    );
  }
  return { problems };
}

export async function fetchMarketplaceManifest(url = process.env.ZPR_MARKETPLACE_MANIFEST_URL ?? DEFAULT_MANIFEST_URL) {
  const headers = { Accept: "application/vnd.github.raw" };
  // The token is only ever sent to GitHub's API host — a overridden manifest URL
  // is often exactly how a leak gets set up (dogfood P2, 2026-09-13).
  if (process.env.GH_TOKEN && new URL(url).host === "api.github.com") {
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`marketplace ${MARKETPLACE_REPO} manifest fetch failed: HTTP ${response.status}`);
  }
  return response.json();
}

async function main() {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const plugin = JSON.parse(readFileSync(join(repoRoot, "plugin.json"), "utf8"));
  const manifest = await fetchMarketplaceManifest();
  const { problems } = checkMarketplaceConsistency({ manifest, pluginVersion: plugin.version });
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`PASS ${PLUGIN_NAME} entry present in ${MARKETPLACE_REPO}`);
  console.log(`PASS entry points at ${PLUGIN_REPO} (root path ".")`);
  console.log(`PASS entry version == plugin.json version (${plugin.version}), ref pinned to v${plugin.version}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
