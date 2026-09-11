// Merge-path tagging tail (V1): after gh reports the squash-merge done, GitHub
// must confirm the PR is MERGED, main must be checked out and fast-forwarded,
// and only then is the merged main tagged vX.Y.Z. Every step fails closed — a
// failure returns a merge-path failure with a precise reason; the merge itself
// (if it happened) stays put. Code-owned only: no model output gates a release.
import { tagMergedRelease } from "./version.mjs";

export async function mergeTail({ run, repoRoot, merged, prNumber }) {
  // GitHub must confirm the merge before any release tagging: a merge that
  // reports success but is not yet MERGED must not be tagged.
  const viewed = await run("gh", ["pr", "view", String(prNumber), "--json", "state"], { cwd: repoRoot });
  let state = null;
  try { state = JSON.parse(viewed.stdout || "{}").state ?? null; } catch { /* error below */ }
  if (viewed.code !== 0 || state !== "MERGED") {
    return { code: 1, stdout: "", stderr: `PR ${prNumber} not confirmed MERGED by GitHub (state=${state ?? "unknown"}): ${(viewed.stderr || viewed.stdout || "").slice(0, 200)}`, timedOut: false };
  }
  const checkout = await run("git", ["checkout", "main"], { cwd: repoRoot });
  if (checkout.code !== 0) {
    return { code: checkout.code, stdout: checkout.stdout, stderr: `git checkout main failed (merge completed, release tagging aborted): ${checkout.stderr.slice(0, 200)}`, timedOut: false };
  }
  const pulled = await run("git", ["pull", "--ff-only"], { cwd: repoRoot });
  if (pulled.code !== 0) {
    return { code: pulled.code, stdout: pulled.stdout, stderr: `git pull --ff-only failed (merge completed, release tagging aborted): ${pulled.stderr.slice(0, 200)}`, timedOut: false };
  }
  const tagged = await tagMergedRelease({ run, repoRoot });
  if (!tagged.ok) {
    return { code: 1, stdout: "", stderr: `release tag failed (merge itself completed): ${tagged.detail}`, timedOut: false };
  }
  return merged;
}
