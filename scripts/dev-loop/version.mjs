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
// so the release TAG is the serialization point — but a read-only check is not
// one: a bare ls-remote leaves a check→merge window in which a concurrent loop
// run can pass the same check and merge the same version (round-5 review P1).
// Instead the tag is RESERVED here by pushing an ANNOTATED tag (I8 convention)
// at the pinned PR head to origin; git ref creation is atomic server-side, so
// exactly one run can create refs/tags/vX.Y.Z — every other run (concurrent or
// later) fails the push and aborts the merge. After the merge is confirmed, the
// tail retargets the reservation onto the merge commit with a force-with-lease
// pinned to the reserved TAG OBJECT (annotated refs point at the tag object —
// only our own reservation may be overwritten; a tag that moved otherwise is a
// human decision, never a silent clobber). If the merge mutation is refused,
// the caller releases the reservation so the version is not stranded.
// Fail-closed aborts the merge; the next run re-assesses against the moved
// main.
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
  // Duplicate-version pre-check: a tag that already exists on origin means
  // this version was already released — merging anyway would land a duplicate
  // version whose tagging the tail must then refuse. Asked of origin directly
  // (ls-remote), never local state. This is only the diagnostic pass; the
  // atomic reservation push below is what actually closes the concurrent-run
  // race.
  const tag = `v${head.version}`;
  const tags = await run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { cwd: repoRoot });
  if (tags.code !== 0) {
    return { ok: false, detail: `git ls-remote --tags origin ${tag} failed (merge aborted): ${(tags.stderr || tags.stdout || "").slice(0, 200)}` };
  }
  if (tags.stdout.trim() !== "") {
    return { ok: false, detail: `release tag ${tag} already exists on origin — version ${head.version} was already released; merge aborted, bump the PR's version and re-run the loop` };
  }
  // Atomic reservation (round-5 review P1), annotated since I8: create the
  // tag object locally at the pinned PR head and push it — git creates the
  // ref server-side only if absent, so two concurrent loop runs cannot both
  // pass; the loser's push is rejected and its merge aborts here, before any
  // mutation. The head OID is a valid target (the PR branch lives on
  // origin), and the tail later retargets the tag onto the merge commit.
  // I8 tag convention (decided; see AGENTS.md): release tags are ANNOTATED —
  // every tag v0.2.0–v0.2.5 already was (verified on origin), and the
  // reservation now matches the convention instead of a lightweight ref that
  // only the never-yet-flown loop path would have produced. The reservation
  // returns BOTH the commit it peels to (the tail's ownership check) and the
  // tag object OID on origin (the force-with-lease old value for retarget).
  const localTag = await run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { cwd: repoRoot });
  if (localTag.code === 0) {
    return { ok: false, detail: `local tag ${tag} already exists (${localTag.stdout.trim().slice(0, 40)}) — a leftover reservation from an aborted run; delete it (git tag -d ${tag}) and re-run the loop` };
  }
  const TAG_MESSAGE = `z-pr-review release ${tag}`;
  const created = await run("git", ["-c", "tag.gpgsign=false", "tag", "-a", tag, "-m", TAG_MESSAGE, headRefOid], { cwd: repoRoot });
  if (created.code !== 0) {
    return { ok: false, detail: `creating the annotated reservation tag ${tag} at ${headRefOid.slice(0, 7)} failed (merge aborted): ${created.stderr.slice(0, 200)}` };
  }
  const reserved = await run("git", ["push", "origin", `refs/tags/${tag}`], { cwd: repoRoot });
  if (reserved.code !== 0) {
    // The remote refused the new ref — most likely a concurrent run released
    // this version first. Drop the local tag object so the next run starts
    // clean, and fail the merge closed.
    await run("git", ["tag", "-d", tag], { cwd: repoRoot });
    return { ok: false, detail: `reserving release tag ${tag} on origin failed (merge aborted) — another run likely released version ${head.version} concurrently, or the push failed: ${(reserved.stderr || reserved.stdout || "").slice(0, 200)}` };
  }
  const reservedObject = await run("git", ["rev-parse", `refs/tags/${tag}`], { cwd: repoRoot });
  if (reservedObject.code !== 0 || !/^[0-9a-f]{40}$/.test(reservedObject.stdout.trim())) {
    // The reservation IS on origin (the push above succeeded); resolve it or
    // the version stays stranded — every later run fails the duplicate-tag
    // pre-check on this half-taken reservation (dogfood round-5 P2). The
    // release verifies ownership before deleting (the reservation peeled to
    // the pinned head at creation); the detail names the manual cleanup when
    // even the verified release fails.
    const released = await releaseTagReservation({ run, repoRoot, tag, reservedCommit: headRefOid });
    const outcome = released.released
      ? "the reservation was released"
      : `the reservation could NOT be fully released (${released.detail}) — delete it manually if it is still this run's`;
    return { ok: false, detail: `cannot resolve the reserved tag object for ${tag}; ${outcome} (merge aborted): ${(reservedObject.stderr || "").slice(0, 200)}` };
  }
  return {
    ok: true,
    tag,
    reservedAt: headRefOid,
    reservedObject: reservedObject.stdout.trim(),
    detail: `version ${main.version} → ${head.version} confirmed at merge time (PR head ${headRefOid.slice(0, 7)}, annotated release tag ${tag} reserved on origin at ${headRefOid.slice(0, 7)})`,
  };
}

// Releases a tag reservation this run took — without ever deleting a tag
// another actor may have moved onto the ref (V2 ground test, the PR #44
// review's refused-merge P2): the remote delete is LEASED to the reserved tag
// object (git honors --force-with-lease on --delete pushes — verified live —
// and the expect value for an annotated tag ref is the TAG OBJECT oid, exactly
// what the reservation returns). Without a known reservedObject (the
// resolve-failure path above), the remote tag is verified first by peeling
// the remote object to the reserved commit (the object was created locally,
// so the peel resolves from the local object store); a tag that no longer
// peels there has been moved and is left in place, disclosed. The local tag
// is deleted only when its ref still resolves to the expected object —
// absent is fine, moved is disclosed. Returns { released, detail };
// released=false means manual cleanup is owed.
export async function releaseTagReservation({ run, repoRoot, tag, reservedObject = null, reservedCommit = null }) {
  const problems = [];
  let leaseObject = reservedObject;
  if (leaseObject === null) {
    const remote = await run("git", ["ls-remote", "origin", `refs/tags/${tag}`], { cwd: repoRoot });
    if (remote.code !== 0) {
      // A failed lookup is NOT an absent tag (dogfood round-1 P2): treating it
      // as absent would report a successful release, suppress the cleanup
      // warning, and strand the remote reservation — fail the release so the
      // disclosure carries instead.
      problems.push(`cannot inspect remote ${tag} (ls-remote failed): ${(remote.stderr || remote.stdout || "no output").trim().slice(0, 200)}`);
    } else {
      const remoteObject = /^([0-9a-f]{40})\s+refs\/tags\//.exec(remote.stdout.trim())?.[1] ?? null;
      if (remoteObject !== null) {
        // Peel equality alone does not establish ownership (dogfood round-1
        // P2): another actor's replacement tag can point at the same commit.
        // An object THIS run created is in the local object store; a
        // remote-only replacement is not — require local presence before
        // deleting. (Concurrent runs share this checkout's store, but
        // verifyBumpAtMerge's local-tag pre-check already serializes them.)
        const knownLocally = await run("git", ["cat-file", "-e", remoteObject], { cwd: repoRoot });
        const peel = await run("git", ["rev-parse", `${remoteObject}^{}`], { cwd: repoRoot });
        if (knownLocally.code === 0 && peel.code === 0 && peel.stdout.trim() === reservedCommit) {
          leaseObject = remoteObject;
        } else {
          problems.push(
            `remote ${tag} cannot be proven this run's reservation (peels to ${peel.code === 0 ? peel.stdout.trim().slice(0, 40) : "nothing resolvable"}, object ${knownLocally.code === 0 ? "known" : "unknown"} locally) — left in place`,
          );
        }
      }
      // An absent remote tag needs no release — there is nothing to delete.
    }
  }
  if (leaseObject !== null) {
    const released = await run(
      "git",
      ["push", "origin", `--force-with-lease=refs/tags/${tag}:${leaseObject}`, "--delete", `refs/tags/${tag}`],
      { cwd: repoRoot },
    );
    if (released.code !== 0) {
      problems.push(`remote delete rejected or failed: ${(released.stderr || released.stdout || "no output").trim().slice(0, 200)}`);
    }
  }
  if (reservedObject !== null) {
    const local = await run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { cwd: repoRoot });
    if (local.code === 0) {
      if (local.stdout.trim() === reservedObject) {
        const del = await run("git", ["tag", "-d", tag], { cwd: repoRoot });
        if (del.code !== 0) problems.push(`local delete failed: ${(del.stderr || del.stdout || "no output").trim().slice(0, 200)}`);
      } else {
        problems.push(`local ${tag} points at ${local.stdout.trim().slice(0, 40)}, not this run's reservation ${reservedObject.slice(0, 40)} — left in place`);
      }
    }
  } else {
    // No reserved object to compare against (the resolve-failure path). When
    // the peel verification established the object (leaseObject), a RESOLVABLE
    // local tag is deleted only if it still points there; a local tag that
    // resolves to anything else — or resolves when nothing was verified —
    // cannot be proven this run's and is left in place, disclosed (dogfood
    // round 2: another actor may have created or moved the shared checkout's
    // tag while this run's own ref was unresolvable). An absent/unresolvable
    // local tag deletes as a no-op.
    const local = await run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { cwd: repoRoot });
    if (local.code === 0 && (leaseObject === null || local.stdout.trim() !== leaseObject)) {
      problems.push(`local ${tag} resolves to ${local.stdout.trim().slice(0, 40)} and cannot be proven this run's — left in place`);
    } else {
      const del = await run("git", ["tag", "-d", tag], { cwd: repoRoot });
      if (del.code !== 0 && !/not found|does not exist/i.test(del.stderr ?? "")) {
        problems.push(`local delete failed: ${(del.stderr || del.stdout || "no output").trim().slice(0, 200)}`);
      }
    }
  }
  return { released: problems.length === 0, detail: problems.join("; ") };
}

// Tagging tail of the merge path: after squash-merge + checkout main + ff-only
// pull, tag the merged main vX.Y.Z from plugin.json and push the tag. The merge
// already happened, so failure here cannot un-merge — it stops the loop with a
// precise reason instead of silently skipping the release tag. An already-known
// tag makes `git tag` fail, which is exactly the fail-closed outcome. An
// unreadable main manifest is that same documented release-tag failure, not an
// escaped exception.
// When the caller passes the pre-merge reservation (verifyBumpAtMerge pushed
// refs/tags/vX.Y.Z at the PR head to serialize concurrent runs), the tag push
// RETARGETS that reservation onto the merge commit with an explicit
// force-with-lease: the move is accepted only if origin's tag still sits at
// the reserved OID, so we can never silently clobber a tag someone else moved.
export async function tagMergedRelease({ run, repoRoot, reservation = null }) {
  const parsed = readManifestVersion(join(repoRoot, "plugin.json"), "plugin.json (main)");
  if (parsed.error) return { ok: false, detail: parsed.error };
  const tag = `v${parsed.version}`;
  if (reservation && reservation.tag !== tag) {
    return { ok: false, detail: `reserved release tag ${reservation.tag} does not match main's version ${parsed.version} (${tag}) — refusing to retarget a reservation that is not ours` };
  }
  // With a reservation, the LOCAL copy of the reserved tag is expected:
  // verifyBumpAtMerge created it (annotated, at the PR head) and pushed it to
  // origin. Only a local tag peeling exactly to the reserved commit may be
  // replaced: `-f -a` retargets it onto HEAD, which tagConfirmedMerge already
  // verified is this PR's merge commit, and the force-with-lease push below
  // moves only our own remote reservation (the lease's old value is the
  // reserved tag OBJECT — annotated refs point at the tag object, not the
  // commit). A local tag anywhere else is a tag we did not reserve — a human
  // decision, never a silent clobber. Without a reservation an existing local
  // tag keeps failing closed exactly as before.
  // The `-c tag.gpgsign=false` prefix is load-bearing: with tag.gpgsign=true
  // (git ≥2.48 semantics) an annotated tag would invoke gpg — inside the
  // headless merge tail, whose piped stdio makes any interactive child hang
  // invisibly (2026-09-13, v0.2.3: a 15-minute vim stall after a completed
  // merge; no timeout guards a hung interactive child). I8 convention
  // (decided): release tags are ANNOTATED (`-a -m`, deterministic message,
  // signing pinned off) — matching every existing tag v0.2.0–v0.2.5 on
  // origin; the earlier "lightweight by design" note described a path that
  // never shipped (all releases to date were supervisor-tagged annotated).
  const TAG_MESSAGE = `z-pr-review release ${tag}`;
  let createArgs = ["-c", "tag.gpgsign=false", "tag", "-a", tag, "-m", TAG_MESSAGE];
  if (reservation) {
    const existing = await run("git", ["rev-parse", `${tag}^{}`], { cwd: repoRoot });
    if (existing.code === 0) {
      if (existing.stdout.trim() !== reservation.reservedAt) {
        return { ok: false, detail: `local tag ${tag} exists at ${existing.stdout.trim().slice(0, 7)}, not the reserved ${reservation.reservedAt.slice(0, 7)} — refusing to overwrite a tag we did not reserve` };
      }
      createArgs = ["-c", "tag.gpgsign=false", "tag", "-f", "-a", tag, "-m", TAG_MESSAGE];
    }
  }
  const created = await run("git", createArgs, { cwd: repoRoot });
  if (created.code !== 0) {
    return { ok: false, detail: `git tag ${tag} failed: ${created.stderr.slice(0, 200)}` };
  }
  const leaseOld = reservation ? reservation.reservedObject : null;
  const pushArgs = reservation
    ? ["push", `--force-with-lease=refs/tags/${tag}:${leaseOld}`, "origin", tag]
    : ["push", "origin", tag];
  const pushed = await run("git", pushArgs, { cwd: repoRoot });
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
