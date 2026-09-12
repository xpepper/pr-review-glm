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
// The GraphQL mergePullRequest mutation takes the head OID itself and GitHub
// rejects the whole mutation if the head moved — the pin is atomic at the
// server, closing the window the CLI command leaves open.
const MERGE_MUTATION = [
  "mutation($pr: ID!, $head: GitObjectID!) {",
  "  mergePullRequest(input: {pullRequestId: $pr, mergeMethod: SQUASH, headRefOid: $head}) { mergeCommit { oid } }",
  "}",
].join("\n");

export async function squashMergeAtHead({ run, repoRoot, prNumber, expectedHeadRefOid }) {
  // The mutation needs the PR's GraphQL id (not its number) and its branch
  // name (for the --delete-branch equivalent below).
  const view = await run("gh", ["pr", "view", String(prNumber), "--json", "id,headRefName"], { cwd: repoRoot });
  let pr = null;
  try { pr = JSON.parse(view.stdout || "{}"); } catch { /* handled below */ }
  if (view.code !== 0 || !pr?.id || typeof pr.headRefName !== "string" || !pr.headRefName) {
    return { code: 1, stdout: view.stdout, stderr: `cannot resolve PR ${prNumber}'s GraphQL id / branch name (merge aborted): ${(view.stderr || view.stdout || "").slice(0, 200)}`, timedOut: false };
  }
  const api = await run("gh", ["api", "graphql", "-f", `query=${MERGE_MUTATION}`, "-f", `pr=${pr.id}`, "-f", `head=${expectedHeadRefOid}`], { cwd: repoRoot });
  let payload = null;
  try { payload = JSON.parse(api.stdout || "{}"); } catch { /* handled below */ }
  const errors = Array.isArray(payload?.errors) ? payload.errors : null;
  if (api.code !== 0 || errors || !payload?.data?.mergePullRequest) {
    const detail = errors?.map((error) => error?.message ?? String(error)).join("; ")
      ?? (api.stderr || api.stdout || "no output").slice(0, 200);
    return { code: 1, stdout: api.stdout, stderr: `GitHub refused the squash-merge of PR ${prNumber} pinned to reviewed head ${expectedHeadRefOid.slice(0, 7)} (merge aborted — the head likely moved; re-run the loop to re-assess): ${detail}`, timedOut: false };
  }
  // --delete-branch equivalent: the mutation has no such flag, so the branch
  // is deleted after the merge. Failure is disclosed but cannot un-merge — the
  // tail still runs so the merged head gets tagged and post-merge gates run.
  const del = await run("git", ["push", "origin", "--delete", pr.headRefName], { cwd: repoRoot });
  const warning = del.code === 0 ? "" : `\nwarning: branch ${pr.headRefName} was not deleted (delete it manually): ${(del.stderr || del.stdout || "").slice(0, 200)}`;
  return { code: 0, stdout: api.stdout, stderr: warning, timedOut: false };
}

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
