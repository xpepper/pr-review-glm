// V1 release versioning (spec, dev-loop Amendments 2026-09-11): every merged
// increment bumps plugin.json's semver version, enforced by a pre-merge gate,
// and the merge path tags the merged main vX.Y.Z. Both are code-owned and
// fail-closed — no model output ever decides a release.
import { readFileSync } from "node:fs";
import { isFullOid } from "./gates.mjs";
import { join } from "node:path";

// Strict X.Y.Z (no prerelease/build suffixes): pre-1.0 bumps move patch (additive)
// or minor (breaking), and the loop only ever compares strings, so a suffix
// would be un-tagged territory the design never settled.
// (?![\s\S]) anchors truly to end-of-string: JS `$` also matches just before a
// final "\n", so "1.2.3\n" would otherwise pass validation and later produce a
// `git tag` argument with an embedded newline — a merge that cannot be tagged.
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?![\s\S])/;
// Strict semver also forbids leading zeros in numeric identifiers ("01.2.3").
const hasLeadingZero = (part) => part.length > 1 && part.startsWith("0");

export function parseVersion(manifestText, source) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return { error: `${source} is not parseable JSON` };
  }
  const version = manifest?.version;
  if (typeof version !== "string" || !SEMVER_PATTERN.test(version) || version.split(".").some(hasLeadingZero)) {
    return { error: `${source} has no strict X.Y.Z version: ${String(version)}` };
  }
  return { version };
}

// Read and parse a manifest from disk, reporting read failures (missing file,
// unreadable, not valid UTF-8…) as the same fail-closed error shape instead of
// throwing out of the gate or the merge tail.
function readManifestVersion(manifestPath, source) {
  let text;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (error) {
    return { error: `${source} cannot be read: ${error.code ?? String(error.message ?? error)}` };
  }
  return parseVersion(text, source);
}

// Numeric identifier comparison without Number(): identifiers beyond 2^53
// would silently collide as floats, losing semver ordering. The strict pattern
// guarantees digit-only strings with no leading zeros, so longer is greater
// and equal length compares lexically.
function compareIdentifiers(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a !== b) return a < b ? -1 : 1;
  return 0;
}

// Numeric major.minor.patch comparison: -1, 0, or 1.
export function compareVersions(a, b) {
  const aParts = a.split(".");
  const bParts = b.split(".");
  for (let i = 0; i < 3; i++) {
    const ordering = compareIdentifiers(aParts[i], bParts[i]);
    if (ordering !== 0) return ordering;
  }
  return 0;
}

// Bump gate: the PR's plugin.json version must be a valid semver strictly
// greater than origin/main's — equal or lower fails, so downgrades never land.
// The baseline comes from git (not the local working tree, which the gate
// itself runs in — on the PR branch), so a missing/unreadable
// baseline is a git failure and fails closed. An unreadable PR-branch
// manifest is a failed gate, not a crash.
export async function gateVersionBump({ run, repoRoot }) {
  const baseline = await run("git", ["show", "origin/main:plugin.json"], { cwd: repoRoot });
  if (baseline.code !== 0) {
    return { name: "version-bump", ok: false, detail: `cannot read plugin.json on origin/main: ${baseline.stderr.slice(0, 200)}` };
  }
  const main = parseVersion(baseline.stdout, "origin/main:plugin.json");
  if (main.error) return { name: "version-bump", ok: false, detail: main.error };
  const branch = readManifestVersion(join(repoRoot, "plugin.json"), "plugin.json (PR branch)");
  if (branch.error) return { name: "version-bump", ok: false, detail: branch.error };
  const ordering = compareVersions(branch.version, main.version);
  if (ordering <= 0) {
    return { name: "version-bump", ok: false, detail: `plugin.json version ${branch.version} is ${ordering === 0 ? "unchanged" : "not greater"} vs main's ${main.version} — every merged increment bumps (pre-1.0: additive → patch, breaking → minor)` };
  }
  return { name: "version-bump", ok: true, detail: `version ${main.version} → ${branch.version}` };
}

// Pre-merge bump re-check: the bump gate compared the PR's version against
// origin/main at assessment time, and that baseline can go stale — another
// release merging in between could already carry this PR's version, landing an
// "unchanged" version after all. The version-side twin of the headRefOid pin:
// fetch main, read the PR head's manifest BY ITS REMOTE OID (never the local
// checkout), and re-verify the ordering immediately before the merge mutation.
// The freshly fetched OID must equal the reviewed head the loop pinned — a
// version re-check of one head must never merge another. Version uniqueness
// has no server-side pin (unlike the head, GitHub holds no "expected version"),
// so the release TAG is the serialization point: every merged release tags
// vX.Y.Z, the tag is checked on origin here (pre-merge), and the tail's
// non-forced `git push origin vX.Y.Z` is itself atomic (rejected if the tag
// exists) — the backstop if a same-version release lands inside the residual
// check→merge window. Fail-closed aborts the merge; the next run re-assesses
// against the moved main. The seconds-wide check→merge window that remains is
// the same one the head pin accepts by design, and the merge tail's
// merge-commit pin backstops it post-hoc: if another merge sneaks in anyway,
// main's HEAD will not be this PR's merge commit and the tail refuses to tag
// (loud stop, human decides).
export async function verifyBumpAtMerge({ run, repoRoot, prNumber, expectedHeadRefOid }) {
  // The explicit refspec is load-bearing: a bare `git fetch origin main`
  // updates only FETCH_HEAD, so `git show origin/main:plugin.json` below would
  // re-read the stale remote-tracking ref the assessment-time gate saw — the
  // very staleness this re-check exists to catch. The forced refspec updates
  // refs/remotes/origin/main itself.
  const fetched = await run("git", ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"], { cwd: repoRoot });
  if (fetched.code !== 0) {
    return { ok: false, detail: `git fetch origin main failed (merge aborted): ${(fetched.stderr || fetched.stdout || "").slice(0, 200)}` };
  }
  const pr = await run("gh", ["pr", "view", String(prNumber), "--json", "headRefOid"], { cwd: repoRoot });
  let headRefOid = null;
  try { headRefOid = JSON.parse(pr.stdout || "{}").headRefOid ?? null; } catch { /* validated below */ }
  if (pr.code !== 0 || !isFullOid(headRefOid)) {
    return { ok: false, detail: `cannot pin PR ${prNumber} headRefOid for the bump re-check (merge aborted): ${(pr.stderr || pr.stdout || "").slice(0, 200)}` };
  }
  if (headRefOid !== expectedHeadRefOid) {
    return { ok: false, detail: `PR ${prNumber} head is ${headRefOid.slice(0, 7)} but the loop pinned the reviewed head ${String(expectedHeadRefOid).slice(0, 7)} — a version re-check of one head must never merge another; merge aborted, re-run the loop to re-assess` };
  }
  const mainText = await run("git", ["show", "origin/main:plugin.json"], { cwd: repoRoot });
  if (mainText.code !== 0) {
    return { ok: false, detail: `cannot read plugin.json on origin/main (merge aborted): ${mainText.stderr.slice(0, 200)}` };
  }
  const headText = await run("git", ["show", `${headRefOid}:plugin.json`], { cwd: repoRoot });
  if (headText.code !== 0) {
    return { ok: false, detail: `cannot read plugin.json at the PR head ${headRefOid.slice(0, 7)} (merge aborted): ${headText.stderr.slice(0, 200)}` };
  }
  const main = parseVersion(mainText.stdout, "origin/main:plugin.json");
  if (main.error) return { ok: false, detail: `${main.error} (merge aborted)` };
  const head = parseVersion(headText.stdout, `PR head ${headRefOid.slice(0, 7)}:plugin.json`);
  if (head.error) return { ok: false, detail: `${head.error} (merge aborted)` };
  const ordering = compareVersions(head.version, main.version);
  if (ordering <= 0) {
    return { ok: false, detail: `plugin.json version ${head.version} is ${ordering === 0 ? "unchanged vs" : "not greater than"} main's ${main.version} at merge time — main moved since assessment; merge aborted, re-run the loop to re-assess` };
  }
  // Duplicate-version guard: every merged release tags vX.Y.Z, so a tag that
  // already exists on origin means this version was already released — merging
  // anyway would land a duplicate version whose tagging the tail must then
  // refuse. Asked of origin directly (ls-remote), never local state.
  const tag = `v${head.version}`;
  const tags = await run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { cwd: repoRoot });
  if (tags.code !== 0) {
    return { ok: false, detail: `git ls-remote --tags origin ${tag} failed (merge aborted): ${(tags.stderr || tags.stdout || "").slice(0, 200)}` };
  }
  if (tags.stdout.trim() !== "") {
    return { ok: false, detail: `release tag ${tag} already exists on origin — version ${head.version} was already released; merge aborted, bump the PR's version and re-run the loop` };
  }
  return { ok: true, detail: `version ${main.version} → ${head.version} confirmed at merge time (PR head ${headRefOid.slice(0, 7)}, tag ${tag} free)` };
}

// Tagging tail of the merge path: after squash-merge + checkout main + ff-only
// pull, tag the merged main vX.Y.Z from plugin.json and push the tag. The merge
// already happened, so failure here cannot un-merge — it stops the loop with a
// precise reason instead of silently skipping the release tag. An already-known
// tag makes `git tag` fail, which is exactly the fail-closed outcome. An
// unreadable main manifest is that same documented release-tag failure, not an
// escaped exception.
export async function tagMergedRelease({ run, repoRoot }) {
  const parsed = readManifestVersion(join(repoRoot, "plugin.json"), "plugin.json (main)");
  if (parsed.error) return { ok: false, detail: parsed.error };
  const tag = `v${parsed.version}`;
  const created = await run("git", ["tag", tag], { cwd: repoRoot });
  if (created.code !== 0) {
    return { ok: false, detail: `git tag ${tag} failed: ${created.stderr.slice(0, 200)}` };
  }
  const pushed = await run("git", ["push", "origin", tag], { cwd: repoRoot });
  if (pushed.code !== 0) {
    // Drop the local tag so a retried release tagging starts clean instead of
    // tripping over a tag that exists locally but not on origin. If the delete
    // also fails, disclose it — the leftover local tag is what a retry hits.
    let detail = `git push origin ${tag} failed: ${pushed.stderr.slice(0, 200)}`;
    const deleted = await run("git", ["tag", "-d", tag], { cwd: repoRoot });
    if (deleted.code !== 0) {
      detail += `; additionally, removing the un-pushed local tag failed (${deleted.stderr.slice(0, 200)}) — delete it manually before retrying`;
    }
    return { ok: false, detail };
  }
  return { ok: true, detail: `tagged merged main ${tag}` };
}
