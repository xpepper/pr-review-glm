// Merge-path tagging tail (V1): after gh reports the squash-merge done, GitHub
// must confirm the PR is MERGED, main must be checked out and fast-forwarded,
// and the resulting HEAD must be exactly this PR's merge commit — only then is
// the merged main tagged vX.Y.Z. Every step fails closed — a failure returns a
// merge-path failure with a precise reason; the merge itself (if it happened)
// stays put. Code-owned only: no model output gates a release.
import { tagMergedRelease } from "./version.mjs";

// A merge can report success while GitHub still shows OPEN for a moment, or sit
// in QUEUED on a merge queue. Poll instead of failing on the first non-MERGED
// view; after this window the tail fails closed for a human to retry — the
// squash-merge itself may already have completed, so the failure must say
// exactly what did and did not happen (release tag NOT created, post-merge
// checks NOT run).
const MERGE_CONFIRM_ATTEMPTS = 30;
const MERGE_CONFIRM_DELAY_MS = 10_000;

export async function mergeTail({ run, repoRoot, merged, prNumber, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  // GitHub must confirm the merge before any release tagging: a merge that
  // reports success but is not yet MERGED must not be tagged. Poll through the
  // transient OPEN/QUEUED window so a briefly delayed merge still gets tagged.
  let state = null;
  let viewError = "";
  for (let attempt = 1; attempt <= MERGE_CONFIRM_ATTEMPTS; attempt++) {
    const viewed = await run("gh", ["pr", "view", String(prNumber), "--json", "state,mergeCommit"], { cwd: repoRoot });
    try {
      const parsed = JSON.parse(viewed.stdout || "{}");
      state = parsed.state ?? null;
      if (viewed.code === 0 && state === "MERGED" && parsed.mergeCommit?.oid) {
        return await tagConfirmedMerge({ run, repoRoot, merged, prNumber, mergeOid: parsed.mergeCommit.oid });
      }
      viewError = (viewed.stderr || viewed.stdout || "").slice(0, 200);
    } catch {
      viewError = `gh pr view output is not JSON: ${(viewed.stdout || viewed.stderr || "").slice(0, 200)}`;
      state = null;
    }
    if (attempt < MERGE_CONFIRM_ATTEMPTS) await sleep(MERGE_CONFIRM_DELAY_MS);
  }
  return { code: 1, stdout: "", stderr: `PR ${prNumber} not confirmed MERGED by GitHub after ${MERGE_CONFIRM_ATTEMPTS} attempts over ~${Math.round((MERGE_CONFIRM_ATTEMPTS * MERGE_CONFIRM_DELAY_MS) / 1000)}s (state=${state ?? "unknown"}): ${viewError} — the squash-merge may already have completed; the release tag was NOT created and post-merge checks did NOT run: verify the PR state, tag vX.Y.Z manually if merged, and run the post-merge gates by hand`, timedOut: false };
}

async function tagConfirmedMerge({ run, repoRoot, merged, prNumber, mergeOid }) {
  const checkout = await run("git", ["checkout", "main"], { cwd: repoRoot });
  if (checkout.code !== 0) {
    return { code: checkout.code, stdout: checkout.stdout, stderr: `git checkout main failed (merge completed, release tagging aborted): ${checkout.stderr.slice(0, 200)}`, timedOut: false };
  }
  const pulled = await run("git", ["pull", "--ff-only"], { cwd: repoRoot });
  if (pulled.code !== 0) {
    return { code: pulled.code, stdout: pulled.stdout, stderr: `git pull --ff-only failed (merge completed, release tagging aborted): ${pulled.stderr.slice(0, 200)}`, timedOut: false };
  }
  // Tag only the exact commit this PR's merge produced: if another merge landed
  // first (or the pull brought in anything else), tagging HEAD would attach
  // this release to a different PR's commit — fail closed instead.
  const head = await run("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (head.code !== 0) {
    return { code: head.code, stdout: "", stderr: `git rev-parse HEAD failed (merge completed, release tagging aborted): ${head.stderr.slice(0, 200)}`, timedOut: false };
  }
  if (head.stdout.trim() !== mergeOid) {
    return { code: 1, stdout: "", stderr: `main HEAD ${head.stdout.trim().slice(0, 7)} is not PR ${prNumber}'s merge commit ${mergeOid.slice(0, 7)} — another merge landed first; not tagging the wrong commit (human decides: tag ${mergeOid.slice(0, 7)} manually or leave untagged)`, timedOut: false };
  }
  const tagged = await tagMergedRelease({ run, repoRoot });
  if (!tagged.ok) {
    return { code: 1, stdout: "", stderr: `release tag failed (merge itself completed): ${tagged.detail}`, timedOut: false };
  }
  return merged;
}
