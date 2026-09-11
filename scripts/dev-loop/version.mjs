// V1 release versioning (spec, dev-loop Amendments 2026-09-11): every merged
// increment bumps plugin.json's semver version, enforced by a pre-merge gate,
// and the merge path tags the merged main vX.Y.Z. Both are code-owned and
// fail-closed — no model output ever decides a release.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Strict X.Y.Z (no prerelease/build suffixes): pre-1.0 bumps move patch (additive)
// or minor (breaking), and the loop only ever compares strings, so a suffix
// would be un-tagged territory the design never settled.
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

export function parseVersion(manifestText, source) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return { error: `${source} is not parseable JSON` };
  }
  const version = manifest?.version;
  if (typeof version !== "string" || !SEMVER_PATTERN.test(version)) {
    return { error: `${source} has no strict X.Y.Z version: ${String(version)}` };
  }
  return { version };
}

// Bump gate: the PR's plugin.json version must be a valid semver and differ
// from origin/main's. The baseline comes from git (not the local working tree,
// which the gate itself runs in — on the PR branch), so a missing/unreadable
// baseline is a git failure and fails closed.
export async function gateVersionBump({ run, repoRoot }) {
  const baseline = await run("git", ["show", "origin/main:plugin.json"], { cwd: repoRoot });
  if (baseline.code !== 0) {
    return { name: "version-bump", ok: false, detail: `cannot read plugin.json on origin/main: ${baseline.stderr.slice(0, 200)}` };
  }
  const main = parseVersion(baseline.stdout, "origin/main:plugin.json");
  if (main.error) return { name: "version-bump", ok: false, detail: main.error };
  const branch = parseVersion(readFileSync(join(repoRoot, "plugin.json"), "utf8"), "plugin.json (PR branch)");
  if (branch.error) return { name: "version-bump", ok: false, detail: branch.error };
  if (branch.version === main.version) {
    return { name: "version-bump", ok: false, detail: `plugin.json version ${branch.version} is unchanged vs main — every merged increment bumps (pre-1.0: additive → patch, breaking → minor)` };
  }
  return { name: "version-bump", ok: true, detail: `version ${main.version} → ${branch.version}` };
}

// Tagging tail of the merge path: after squash-merge + checkout main + ff-only
// pull, tag the merged main vX.Y.Z from plugin.json and push the tag. The merge
// already happened, so failure here cannot un-merge — it stops the loop with a
// precise reason instead of silently skipping the release tag. An already-known
// tag makes `git tag` fail, which is exactly the fail-closed outcome.
export async function tagMergedRelease({ run, repoRoot }) {
  const parsed = parseVersion(readFileSync(join(repoRoot, "plugin.json"), "utf8"), "plugin.json (main)");
  if (parsed.error) return { ok: false, detail: parsed.error };
  const tag = `v${parsed.version}`;
  const created = await run("git", ["tag", tag], { cwd: repoRoot });
  if (created.code !== 0) {
    return { ok: false, detail: `git tag ${tag} failed: ${created.stderr.slice(0, 200)}` };
  }
  const pushed = await run("git", ["push", "origin", tag], { cwd: repoRoot });
  if (pushed.code !== 0) {
    return { ok: false, detail: `git push origin ${tag} failed: ${pushed.stderr.slice(0, 200)}` };
  }
  return { ok: true, detail: `tagged merged main ${tag}` };
}
