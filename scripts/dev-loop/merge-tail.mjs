// Merge path (V1): a server-pinned squash merge (the reviewed head enforced
// atomically at GitHub) plus the tagging tail — after the mutation reports
// success, GitHub must confirm the PR is MERGED, main must be checked out and fast-forwarded,
// and the resulting HEAD must be exactly this PR's merge commit — only then is
// the merged main tagged vX.Y.Z. Every step fails closed — a failure returns a
// merge-path failure with a precise reason; the merge itself (if it happened)
// stays put. Code-owned only: no model output gates a release.
import { tagMergedRelease } from "./version.mjs";

// Server-side enforcement of the reviewed head (P1: `gh pr merge` merges
// whatever head GitHub currently holds, so the loop's local pin can lose a
// race in the seconds between fetchPrHead/verifyBumpAtMerge and the merge).
// The GraphQL mergePullRequest mutation takes the head OID itself — via its
// `expectedHeadOid` input field — and GitHub rejects the whole mutation if
// the head moved: the pin is atomic at the server, closing the window the
// CLI command leaves open. Schema note (introspected 2026-09-12, after the
// mutation's first live use failed schema validation):
// MergePullRequestPayload has NO mergeCommit of its own — only actor,
// clientMutationId, pullRequest — so the merge commit is selected through
// the payload's pullRequest. The earlier selection `{ mergeCommit { oid } }`
// was schema-invalid and the first live merge (C1, PR #27) died fail-closed
// on it: "GitHub did not confirm the squash-merge … Field 'mergeCommit'".
const MERGE_MUTATION = [
  "mutation($pr: ID!, $head: GitObjectID!) {",
  "  mergePullRequest(input: {pullRequestId: $pr, mergeMethod: SQUASH, expectedHeadOid: $head}) { pullRequest { mergeCommit { oid } } }",
  "}",
].join("\n");

export async function squashMergeAtHead({ run, repoRoot, prNumber, expectedHeadRefOid }) {
  // The mutation needs the PR's GraphQL id (not its number) and its branch
  // name (returned for the post-confirmation branch deletion in the merge dep).
  // isCrossRepository tells that deletion WHICH remote owns the branch — a
  // fork PR's branch lives in the fork, and pushing --delete through the base
  // repository's remote must never happen (it would fail, or worse delete a
  // same-named branch in the base repo).
  const view = await run("gh", ["pr", "view", String(prNumber), "--json", "id,headRefName,isCrossRepository"], { cwd: repoRoot });
  let pr = null;
  try { pr = JSON.parse(view.stdout || "{}"); } catch { /* handled below */ }
  if (view.code !== 0 || !pr?.id || typeof pr.headRefName !== "string" || !pr.headRefName || typeof pr.isCrossRepository !== "boolean") {
    return { code: 1, stdout: view.stdout, stderr: `cannot resolve PR ${prNumber}'s GraphQL id / branch name / fork status (merge aborted): ${(view.stderr || view.stdout || "").slice(0, 200)}`, timedOut: false };
  }
  const api = await run("gh", ["api", "graphql", "-f", `query=${MERGE_MUTATION}`, "-f", `pr=${pr.id}`, "-f", `head=${expectedHeadRefOid}`], { cwd: repoRoot });
  let payload = null;
  try { payload = JSON.parse(api.stdout || "{}"); } catch { /* handled below */ }
  const errors = Array.isArray(payload?.errors) ? payload.errors : null;
  const mergeCommitOid = payload?.data?.mergePullRequest?.pullRequest?.mergeCommit?.oid ?? null;
  if (api.code !== 0 || errors || !payload?.data?.mergePullRequest || !mergeCommitOid) {
    // A data.mergePullRequest object without a mergeCommit oid is NOT a
    // confirmed merge (e.g. an already-merged edge) — treat it as refused, not
    // as success: the branch must never be deleted or tagged on that basis.
    const detail = errors?.map((error) => error?.message ?? String(error)).join("; ")
      ?? (api.stderr || api.stdout || "no output").slice(0, 200);
    return { code: 1, stdout: api.stdout, stderr: `GitHub did not confirm the squash-merge of PR ${prNumber} pinned to reviewed head ${expectedHeadRefOid.slice(0, 7)} (merge aborted — the head likely moved or the PR was not mergeable; re-run the loop to re-assess): ${detail}`, timedOut: false };
  }
  return { code: 0, stdout: api.stdout, stderr: "", timedOut: false, branch: pr.headRefName, isCrossRepository: pr.isCrossRepository, mergeCommitOid };
}

// The --delete-branch equivalent, isolated so the merge dep can run it ONLY
// after the tail confirmed MERGED and the release tag landed (run-3 dogfood
// P1: deleting before confirmation strands a possibly-unmerged PR without its
// branch). Failure is disclosed as a warning, never a failed merge — it cannot
// un-merge what already landed. A fork PR's branch lives in the FORK's remote:
// `git push origin --delete` through the base repository must never run for it
// (run-3 P1 — it either fails or deletes an unrelated same-named base branch);
// the fork's own branch is the fork owner's to keep. The local branch is pruned
// in both cases (`gh pr merge --delete-branch` used to do this; a missing local
// branch — a fork PR never checked out here — is fine, nothing to prune).
export async function deleteMergedBranch({ run, repoRoot, branch, isCrossRepository }) {
  const warnings = [];
  // Informational, never a warning: skipping the remote delete is the correct
  // outcome for a fork PR — nothing to clean up on this remote. The local
  // prune below still runs.
  let note = null;
  if (isCrossRepository) {
    note = `branch ${branch} lives in the PR author's fork, not this remote — remote deletion skipped (delete it in the fork if desired)`;
  } else {
    const del = await run("git", ["push", "origin", "--delete", branch], { cwd: repoRoot });
    if (del.code !== 0) {
      warnings.push(`remote branch ${branch} was not deleted (delete it manually): ${(del.stderr || del.stdout || "").slice(0, 200)}`);
    }
  }
  const local = await run("git", ["branch", "-D", branch], { cwd: repoRoot });
  // "not found" means the branch was never checked out locally (fork PR) —
  // not debris, so it is not a warning.
  if (local.code !== 0 && !/not found/i.test(local.stderr || local.stdout || "")) {
    warnings.push(`local branch ${branch} was not deleted (delete it manually): ${(local.stderr || local.stdout || "").slice(0, 200)}`);
  }
  if (warnings.length) return { ok: false, detail: warnings.join("; ") };
  return note ? { ok: true, note } : { ok: true };
}

// A merge can report success while GitHub still shows OPEN for a moment, or sit
// in QUEUED on a merge queue. Poll instead of failing on the first non-MERGED
// view; after this window the tail fails closed for a human to retry — the
// squash-merge itself may already have completed, so the failure must say
// exactly what did and did not happen (release tag NOT created, post-merge
// checks NOT run).
const MERGE_CONFIRM_ATTEMPTS = 30;
const MERGE_CONFIRM_DELAY_MS = 10_000;

export async function mergeTail({ run, repoRoot, merged, prNumber, reservation = null, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  // GitHub must confirm the merge before any release tagging: a merge that
  // reports success but is not yet MERGED must not be tagged. Poll through the
  // transient OPEN/QUEUED window so a briefly delayed merge still gets tagged;
  // CLOSED is terminal (a closed-unmerged PR can never become MERGED), so it
  // fails immediately instead of burning the whole window.
  let state = null;
  let viewError = "";
  for (let attempt = 1; attempt <= MERGE_CONFIRM_ATTEMPTS; attempt++) {
    const viewed = await run("gh", ["pr", "view", String(prNumber), "--json", "state,mergeCommit"], { cwd: repoRoot });
    try {
      const parsed = JSON.parse(viewed.stdout || "{}");
      state = parsed.state ?? null;
      if (viewed.code === 0 && state === "MERGED" && parsed.mergeCommit?.oid) {
        return await tagConfirmedMerge({ run, repoRoot, merged, prNumber, mergeOid: parsed.mergeCommit.oid, reservation });
      }
      if (state === "CLOSED" && viewed.code === 0) {
        return { code: 1, stdout: "", stderr: `PR ${prNumber} is CLOSED, not MERGED (terminal state — not polling further): ${(viewed.stderr || "the squash-merge did not land").slice(0, 200)}`, timedOut: false };
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

async function tagConfirmedMerge({ run, repoRoot, merged, prNumber, mergeOid, reservation }) {
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
  const tagged = await tagMergedRelease({ run, repoRoot, reservation });
  if (!tagged.ok) {
    return { code: 1, stdout: "", stderr: `release tag failed (merge itself completed): ${tagged.detail}`, timedOut: false };
  }
  return merged;
}
