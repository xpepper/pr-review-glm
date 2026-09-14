// Marketplace release publication (R45, issue #45): the public index
// xpepper/copilot-plugins pins z-pr-review's entry to a release tag
// (`source.ref`), so an entry that names a tag which does not exist yet breaks
// `copilot plugin install/update` for as long as the ref is missing. Until R45
// the pre-merge consistency gate required the LIVE entry to equal plugin.json,
// which forced the entry bump BEFORE the merge pushed the tag — a window (as
// long as the increment took to merge) where installs pointed at a missing ref.
// The process now closes that window structurally:
//   - PRE-MERGE (tests/smoke-m1.mjs, run inside gateSmokes): the entry may
//     match EITHER plugin.json (an operator may still bump early) OR the last
//     released tag (the normal state while a new version is in flight).
//   - POST-MERGE (bumpMarketplaceEntry, wired into the loop's merge tail in
//     scripts/dev-loop.mjs AFTER the release tag exists): bump the entry's
//     version and source.ref together, then verify — including a fail-loudly
//     check that the pinned tag exists on origin.
// All decisions here are code-owned (AGENTS.md: no model output in authority
// paths). The pure rules are shared with the smoke through this module — the
// smoke re-exports checkMarketplaceConsistency so tests keep one import surface.
import { compareVersions, isStrictVersion } from "./version.mjs";

export const MARKETPLACE_REPO = "xpepper/copilot-plugins";
export const PLUGIN_NAME = "z-pr-review";
export const PLUGIN_REPO = "xpepper/pr-review-glm";
export const PLUGIN_ROOT = ".";
export const MANIFEST_PATH = ".github/plugin/marketplace.json";

// The entry's expected source identity — OUR repository at the repo root, the
// same coordinates checkMarketplaceConsistency enforces pre-merge. Carried as
// one predicate over the module's coordinates (not literals at each check
// site) because "published" and "already published" both mean installs resolve
// from THIS repo: version+ref agreement alone would let a concurrent edit that
// repointed the entry (repo or path) claim success while installs resolve
// elsewhere (dogfood P2 fold, PR #49).
const isOurSource = (entry) =>
  entry?.source?.repo === PLUGIN_REPO && entry?.source?.path === PLUGIN_ROOT;

// Pre-merge consistency rules (either-or since R45 — see header). Every problem
// line names the marketplace repo so a failing gate points at the place to
// fix, not just the symptom.
//
// Deliberate scope (carried over from M1, updated for R45): the rules verify
// MANIFEST consistency only. The entry's pinned tag is NOT existence-checked
// here: under arm 1 (entry == plugin.json) the tag v{plugin.json} is pushed at
// the merge, so pre-merge it may legitimately not exist yet — that residual
// window is exactly what the post-merge bump step closes for future releases.
// Tag existence is enforced post-merge by bumpMarketplaceEntry (and by the
// merge-time tagging that precedes it).
export function checkMarketplaceConsistency({ manifest, pluginVersion, lastReleasedVersion = null }) {
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
  if (entry.source?.path !== PLUGIN_ROOT) {
    problems.push(
      `marketplace ${MARKETPLACE_REPO} entry ${PLUGIN_NAME} must use the repo root (path ${JSON.stringify(PLUGIN_ROOT)}), found ${JSON.stringify(entry.source?.path)}`,
    );
  }
  // Either-or acceptance (R45): the entry matches plugin.json (an operator
  // bumped early — the M1-era behavior) or the last released tag (the normal
  // state while a new version is in flight; the loop's merge tail bumps the
  // entry after the release tag exists).
  const accepted = new Set([pluginVersion]);
  if (lastReleasedVersion !== null && lastReleasedVersion !== undefined) accepted.add(lastReleasedVersion);
  if (!accepted.has(entry.version)) {
    const lastNote = lastReleasedVersion
      ? `the last released tag v${lastReleasedVersion}`
      : "no release tag (none derivable)";
    problems.push(
      `marketplace ${MARKETPLACE_REPO} entry ${PLUGIN_NAME} version ${String(entry.version)} matches neither plugin.json ${pluginVersion} nor ${lastNote} — the loop's merge tail bumps the entry (version + source.ref together) right after the release tag exists; a version outside both arms means a skipped, failed, or drifted bump (fix the entry by hand: version + source.ref together, one-line direct push, disclosed in the increment PR)`,
    );
  }
  // Whichever arm the entry matched, its ref must pin that same version's tag
  // — an entry that disagrees with itself is broken regardless of the arms.
  if (entry.source?.ref !== `v${entry.version}`) {
    problems.push(
      `marketplace ${MARKETPLACE_REPO} entry ${PLUGIN_NAME} must pin source.ref to v${String(entry.version)} (its own version), found ${JSON.stringify(entry.source?.ref)}`,
    );
  }
  return { problems };
}

// The highest existing release tag vX.Y.Z (strict, leading-zero-free — the
// same rule manifest versions validate by, via isStrictVersion), compared
// NUMERICALLY through compareVersions (both from version.mjs: reused, not
// forked). Tag names that are not strict vX.Y.Z (prerelease refs, branch
// names, junk) are not release tags and are ignored. Returns
// { version: null } when no release tag exists at all (fresh repo) — the
// caller then has only the plugin.json acceptance arm.
export function highestReleaseVersion(tagNames) {
  let best = null;
  for (const name of tagNames ?? []) {
    if (typeof name !== "string" || !name.startsWith("v")) continue;
    const version = name.slice(1);
    if (!isStrictVersion(version)) continue;
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return { version: best };
}

// Pure entry bump for the loop's post-merge step: given the live manifest
// TEXT, produce the bumped TEXT with only our entry's `version` and
// `source.ref` changed (together — a version whose ref lags points installs
// at a missing ref, the exact bug of issue #45). Invariants:
//   - sibling entries survive byte-for-byte (never stomp siblings);
//   - a same-named entry that is not ours (another repository, or a
//     redirected path away from the repo root) is never touched;
//   - the file is rewritten ONLY if it round-trips through the canonical
//     2-space JSON.stringify shape — otherwise the "one-line entry change"
//     discipline would silently become a whole-file reformat, so the bump
//     fails closed and a human fixes the entry by hand.
export function applyEntryBump(manifestText, { to }) {
  if (!isStrictVersion(to)) {
    return { error: `target version ${String(to)} is not strict X.Y.Z — refusing to write it into the marketplace entry` };
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return { error: `marketplace ${MARKETPLACE_REPO} manifest is not parseable JSON — bump the entry by hand` };
  }
  const entry = Array.isArray(manifest?.plugins) ? manifest.plugins.find((p) => p?.name === PLUGIN_NAME) : null;
  if (!entry) {
    return { error: `marketplace ${MARKETPLACE_REPO} has no ${PLUGIN_NAME} entry — refusing to create one automatically; add it by hand` };
  }
  if (!isOurSource(entry)) {
    return { error: `marketplace ${MARKETPLACE_REPO} entry ${PLUGIN_NAME} points at ${String(entry.source?.repo)}/${String(entry.source?.path)}, not ${PLUGIN_REPO}/${PLUGIN_ROOT} — refusing to touch a same-named entry that is not ours` };
  }
  if (`${JSON.stringify(manifest, null, 2)}\n` !== manifestText) {
    return { error: `marketplace ${MARKETPLACE_REPO} manifest formatting is not the canonical 2-space JSON shape — a restringify would rewrite the whole file instead of the one entry; bump the entry by hand` };
  }
  const next = structuredClone(manifest);
  const target = next.plugins.find((p) => p?.name === PLUGIN_NAME);
  target.version = to;
  target.source.ref = `v${to}`;
  return { text: `${JSON.stringify(next, null, 2)}\n` };
}

const CONTENTS_API = `repos/${MARKETPLACE_REPO}/contents/${MANIFEST_PATH}`;

// Reads the live manifest via the GitHub contents API through `gh api`
// (never raw.githubusercontent — the raw CDN can lag a just-pushed change by
// ~5 minutes, the known spurious-failure source documented for the smoke).
// Returns { text, sha } — the sha is the contents API's optimistic-concurrency
// token: a PUT without it would blindly overwrite whatever landed in between.
async function readLiveManifest(run, repoRoot, attempt) {
  const result = await run("gh", ["api", CONTENTS_API], { cwd: repoRoot, timeoutMs: 60_000 });
  let payload = null;
  try { payload = JSON.parse(result.stdout || "{}"); } catch { /* handled below */ }
  const text = typeof payload?.content === "string" && payload.encoding === "base64"
    ? Buffer.from(payload.content, "base64").toString("utf8")
    : null;
  if (result.code !== 0 || text === null || typeof payload?.sha !== "string" || !payload.sha) {
    return { error: `cannot read the live manifest via the contents API (attempt ${attempt}): ${(result.stderr || result.stdout || "no output").slice(0, 200)}` };
  }
  return { text, sha: payload.sha };
}

// The loop's POST-MERGE marketplace step (R45). Runs in the merge tail AFTER
// tagMergedRelease pushed the release tag, so by construction the tag the
// entry will pin exists before any install can be pointed at it — but the
// check is re-made here, fail-loudly with the tag name, because this step is
// the release's publication boundary: the entry must never name a missing ref.
// Sequence: confirm the tag on origin → read the live manifest (contents API,
// with sha) → if already at the target version+ref FROM OUR SOURCE IDENTITY
// (repo + repo root), done (idempotent re-run) → apply the entry-scoped bump
// (version + source.ref together) → PUT the new file with the sha (a stale sha
// is rejected server-side — the API form of pull --rebase: on rejection,
// re-read the FRESH manifest and FIRST re-run the idempotence check on it —
// the target may have landed despite the rejection (response lost) or via a
// concurrent publisher, in which case succeed without another write; a FRESH
// version strictly NEWER than the target fails loudly, never downgrading a
// newer release; otherwise re-apply the bump onto the fresh manifest so
// concurrent sibling-entry changes are preserved, retry ONCE; never force) →
// verify by re-reading the live entry (version+ref AND our source identity).
// Fail-closed everywhere:
// a failure here cannot un-merge, but it leaves the release unpublished — the
// caller stops the loop with this detail so a human fixes the entry by hand.
export async function bumpMarketplaceEntry({ run, repoRoot, version }) {
  const tag = `v${version}`;
  if (!isStrictVersion(version)) {
    return { ok: false, detail: `version ${String(version)} is not strict X.Y.Z — refusing to publish it to the marketplace` };
  }
  // Post-merge check (issue #45): the pinned tag must exist on origin. Asked
  // of origin directly (ls-remote), never local state; a failed lookup is a
  // failed check, not an absent tag.
  const tags = await run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { cwd: repoRoot });
  if (tags.code !== 0) {
    return { ok: false, detail: `git ls-remote failed while confirming release tag ${tag} on origin: ${(tags.stderr || tags.stdout || "no output").slice(0, 200)}` };
  }
  if (tags.stdout.trim() === "") {
    return { ok: false, detail: `release tag ${tag} does not exist on origin — the marketplace entry must never point at a missing ref; the merge tail should have tagged the merged main (tag ${tag} manually if the merge landed, then re-run or bump the entry by hand)` };
  }
  const live = await readLiveManifest(run, repoRoot, 1);
  if (live.error) return { ok: false, detail: live.error };
  // Idempotence: a re-run after a later-step failure must not re-commit. The
  // entry must be at the target version+ref AND still be OUR entry (repo +
  // repo root): version+ref agreement alone would report "already published"
  // while a concurrent edit repointed installs elsewhere (dogfood P2 fold) —
  // a diverged identity falls through to applyEntryBump, which refuses it.
  let liveEntry = null;
  try { liveEntry = JSON.parse(live.text)?.plugins?.find((p) => p?.name === PLUGIN_NAME) ?? null; } catch { liveEntry = null; }
  if (liveEntry?.version === version && liveEntry?.source?.ref === tag && isOurSource(liveEntry)) {
    return { ok: true, detail: `marketplace entry already at ${version}/${tag} — nothing to publish` };
  }
  const message = `z-pr-review ${version} (release tag ${tag})`;
  // One fresh-refetch retry: a PUT rejection is most plausibly a stale sha (a
  // sibling entry landed between our read and our write), and re-applying onto
  // the fresh manifest is the contents-API form of pull --rebase. Sibling
  // entries are carried through by construction (applyEntryBump only touches
  // our entry), and the sha pin means nothing is ever overwritten blindly.
  let firstPutError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const current = attempt === 1 ? live : await readLiveManifest(run, repoRoot, attempt);
    if (current.error) return { ok: false, detail: attempt === 1 ? current.error : `${firstPutError}; then ${current.error}` };
    if (attempt > 1) {
      // The first PUT was rejected, but a rejection is not proof nothing
      // landed: the commit may have succeeded with its response lost, or
      // another publisher may have completed the same target. The fresh
      // manifest is authoritative — re-run the (extended) idempotence check
      // on it (dogfood P2 fold): if the target is already live, the outcome
      // this step exists to reach is reached; succeed without a second PUT.
      let freshEntry = null;
      try { freshEntry = JSON.parse(current.text)?.plugins?.find((p) => p?.name === PLUGIN_NAME) ?? null; } catch { freshEntry = null; }
      if (freshEntry?.version === version && freshEntry?.source?.ref === tag && isOurSource(freshEntry)) {
        return { ok: true, detail: `the fresh manifest already carries ${version}/${tag} — the rejected PUT (or a concurrent publisher) had landed the target; nothing further to publish${firstPutError ? ` (first rejection: ${firstPutError.slice(0, 120)})` : ""}` };
      }
      // Never downgrade: a strictly NEWER version on the fresh manifest means
      // the target is already stale — re-applying it would roll the public
      // entry back off a newer release's tag.
      if (isStrictVersion(freshEntry?.version) && compareVersions(freshEntry.version, version) > 0) {
        return { ok: false, detail: `the fresh ${PLUGIN_NAME} entry is at ${freshEntry.version}, NEWER than the bump target ${version} — refusing to downgrade a newer release (${firstPutError})` };
      }
    }
    const bumped = applyEntryBump(current.text, { to: version });
    if (bumped.error) return { ok: false, detail: bumped.error };
    const put = await run("gh", [
      "api", "-X", "PUT", CONTENTS_API,
      "-f", `message=${message}`,
      "-f", `content=${Buffer.from(bumped.text, "utf8").toString("base64")}`,
      "-f", `sha=${current.sha}`,
    ], { cwd: repoRoot, timeoutMs: 60_000 });
    if (put.code === 0) break;
    firstPutError = `entry bump commit rejected (attempt ${attempt}): ${(put.stderr || put.stdout || "no output").slice(0, 200)}`;
    if (attempt === 2) return { ok: false, detail: `${firstPutError} — one re-fetch retry already made (the pull --rebase equivalent); fix the entry by hand, never force` };
  }
  // Verify: re-read the live manifest (fresh via the contents API) and
  // require our entry to read exactly the released version and tag FROM OUR
  // SOURCE IDENTITY — "verified" means installs resolve from this repo, not
  // just that the version numbers agree (dogfood P2 fold).
  const verify = await readLiveManifest(run, repoRoot, "verify");
  if (verify.error) return { ok: false, detail: `entry bump committed but verification could not re-read the live manifest: ${verify.error}` };
  let verified = null;
  try { verified = JSON.parse(verify.text)?.plugins?.find((p) => p?.name === PLUGIN_NAME) ?? null; } catch { verified = null; }
  if (verified?.version !== version || verified?.source?.ref !== tag || !isOurSource(verified)) {
    return { ok: false, detail: `verification failed: the live ${PLUGIN_NAME} entry reads ${String(verified?.version)}/${String(verified?.source?.ref)} from ${String(verified?.source?.repo)}/${JSON.stringify(verified?.source?.path)}, expected ${version}/${tag} from ${PLUGIN_REPO}/${JSON.stringify(PLUGIN_ROOT)} — inspect ${MARKETPLACE_REPO} by hand` };
  }
  return {
    ok: true,
    detail: `marketplace entry bumped to ${version} (ref ${tag}) in ${MARKETPLACE_REPO}${firstPutError ? ` — retried once after rejection (${firstPutError.slice(0, 120)})` : ""}`,
  };
}

// The merge tail's publication wrapper (dogfood P2 fold, PR #49): the tail
// created/reserved the release tag vX.Y.Z moments before the caller re-reads
// the MUTABLE checkout's plugin.json, so the reparsed version is asserted to
// EQUAL the tag's version before any marketplace interaction. Without the
// assertion a mid-tail checkout change would publish an entry (version + ref)
// that diverges from the tag the merge actually released. Returns
// bumpMarketplaceEntry's result on agreement; a fail-closed { ok: false,
// detail } naming both versions otherwise — with no marketplace write (the
// assertion fires before bumpMarketplaceEntry, so not even the tag-existence
// lookup runs).
export async function publishTaggedVersion({ run, repoRoot, tag, version }) {
  const tagged = typeof tag === "string" && tag.startsWith("v") ? tag.slice(1) : null;
  if (!isStrictVersion(tagged)) {
    return { ok: false, detail: `release tag ${String(tag)} is not a strict vX.Y.Z tag — cannot assert the published version against it; refusing to publish` };
  }
  if (version !== tagged) {
    return {
      ok: false,
      detail: `plugin.json (main) reads version ${String(version)} but the merge tail released tag ${tag} (version ${tagged}) — the checkout changed after tagging; refusing to publish a marketplace entry that diverges from the release tag (reconcile which one is the real release, then publish by hand)`,
    };
  }
  return bumpMarketplaceEntry({ run, repoRoot, version });
}
