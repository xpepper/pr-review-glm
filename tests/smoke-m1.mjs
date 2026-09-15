// M1 no-inference smoke script: marketplace consistency. The public marketplace
// entry for z-pr-review (xpepper/copilot-plugins) must exist, point at THIS
// repository at the repo root, and carry an internally consistent version+ref
// pair matching EITHER plugin.json (an operator bumped early — the M1-era
// behavior) OR the last released tag (the normal state while a new version is
// in flight). This either-or acceptance is the R45 fix (issue #45): the entry
// bump is now a POST-MERGE step of the loop's merge tail
// (scripts/dev-loop/marketplace.mjs, bumpMarketplaceEntry — it runs only after
// the release tag exists), so assessments no longer force the public entry to
// move before the tag does — the window where `copilot plugin
// install/update` pointed at a missing ref. Pure script smoke (no Copilot
// SDK), like smoke-l1.mjs.
//
// Usage:
//   node tests/smoke-m1.mjs
// Optional env: ZPR_MARKETPLACE_MANIFEST_URL (override manifest URL),
// ZPR_TAGS_URL (override the release-tags URL), GH_TOKEN (raises the GitHub
// API rate limit; works unauthenticated too).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkMarketplaceConsistency,
  highestReleaseVersion,
  MARKETPLACE_REPO,
  PLUGIN_NAME,
  PLUGIN_REPO,
} from "../scripts/dev-loop/marketplace.mjs";

// Re-exported for tests/marketplace.test.mjs — the smoke remains the single
// import surface for the gate's rules (pure logic lives in the module so the
// loop's post-merge step and this pre-merge gate share one rule set).
export { checkMarketplaceConsistency };

// The contents API with the raw media type serves the manifest FRESH; the
// raw.githubusercontent CDN can lag a just-pushed entry bump by ~5 minutes,
// which would fail the discipline gate spuriously (verified 2026-09-13).
const DEFAULT_MANIFEST_URL =
  `https://api.github.com/repos/${MARKETPLACE_REPO}/contents/.github/plugin/marketplace.json`;
// Release tags live in THIS repository; the highest existing vX.Y.Z is the
// "last released" arm of the either-or acceptance (R45). per_page=100 covers
// this repo's release cadence for years; the response order is not guaranteed
// to be newest-first, so the max is taken over the whole page numerically.
const DEFAULT_TAGS_URL = `https://api.github.com/repos/${PLUGIN_REPO}/tags?per_page=100`;

// The token is only ever sent to GitHub's API host over HTTPS — an overridden
// URL is often exactly how a leak gets set up (dogfood P2, 2026-09-13), and a
// host check alone would still authorize an http://api.github.com override
// carrying the GH_TOKEN bearer over plaintext (dogfood P2 fold, PR #49). Fail
// closed: ANY non-https URL is refused outright — no Authorization header is
// built, and the fetch itself never runs (this throws before it).
function apiHeaders(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`refusing to fetch ${url}: the GitHub API must be reached over HTTPS — a non-https URL would carry the GH_TOKEN bearer over plaintext`);
  }
  const headers = { Accept: "application/vnd.github.raw" };
  if (process.env.GH_TOKEN && parsed.host === "api.github.com") {
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  }
  return headers;
}

export async function fetchMarketplaceManifest(url = process.env.ZPR_MARKETPLACE_MANIFEST_URL ?? DEFAULT_MANIFEST_URL) {
  const response = await fetch(url, { headers: apiHeaders(url), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`marketplace ${MARKETPLACE_REPO} manifest fetch failed: HTTP ${response.status}`);
  }
  return response.json();
}

// Derives the last released version (highest existing vX.Y.Z tag, numeric
// max via the shared version.mjs comparison — reused, not forked). Fails
// closed: the either-or gate cannot accept the "last released" arm on an
// invented version, so a failed or malformed tags fetch fails the smoke.
export async function fetchLatestReleaseVersion(url = process.env.ZPR_TAGS_URL ?? DEFAULT_TAGS_URL) {
  const response = await fetch(url, { headers: apiHeaders(url), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`${PLUGIN_REPO} release tags fetch failed: HTTP ${response.status}`);
  }
  const tags = await response.json();
  if (!Array.isArray(tags)) {
    throw new Error(`${PLUGIN_REPO} release tags response is not an array`);
  }
  return highestReleaseVersion(tags.map((tag) => tag?.name));
}

async function main() {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const plugin = JSON.parse(readFileSync(join(repoRoot, "plugin.json"), "utf8"));
  const manifest = await fetchMarketplaceManifest();
  const lastReleased = await fetchLatestReleaseVersion();
  const { problems } = checkMarketplaceConsistency({
    manifest,
    pluginVersion: plugin.version,
    lastReleasedVersion: lastReleased.version,
  });
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  const arm = lastReleased.version && lastReleased.version !== plugin.version
    ? `last released tag v${lastReleased.version} (new version ${plugin.version} in flight)`
    : `plugin.json version (${plugin.version})`;
  console.log(`PASS ${PLUGIN_NAME} entry present in ${MARKETPLACE_REPO}`);
  console.log(`PASS entry points at ${PLUGIN_REPO} (root path ".")`);
  console.log(`PASS entry version matches ${arm}, ref pinned to the matching tag`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
