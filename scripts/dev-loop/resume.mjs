// Mid-iteration resume (spec Amendments, 2026-09-11): a stop after the worker
// opened its PR (gate failure, review crash, killed run) leaves exactly the
// debris these probes recognize — the checkout stranded on the increment
// branch, the increment PR open, main otherwise idle. Recovery never trusts
// the debris: a resumed iteration re-enters the full assessment (gates + both
// reviews + head pinning); only the worker re-dispatch is skipped.

// Increment-branch convention (AGENTS.md: "Branch i<N>-<slug>") — the debris
// signature. Anything else falls through to the loud repo-idle failure instead
// of being silently moved.
const INCREMENT_BRANCH = /^([ilvc]\d+)-/i;

const bad = (detail) => ({ name: "checkout-recovery", ok: false, detail });

// Returns null when there is nothing to recover (already on main) or nothing
// this owns (a non-increment branch — repo-idle reports it loudly as before).
// A dirty tree or git failure on an increment branch is fatal: debris we cannot
// safely move needs a human.
export async function recoverCheckout({ run, repoRoot }) {
  const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
  if (branch.code !== 0) return bad(`git rev-parse failed: ${branch.stderr.slice(0, 200)}`);
  const name = branch.stdout.trim();
  if (name === "main" || !INCREMENT_BRANCH.test(name)) return null;
  const status = await run("git", ["status", "--porcelain"], { cwd: repoRoot });
  if (status.code !== 0) return bad(`git status failed: ${status.stderr.slice(0, 200)}`);
  if (status.stdout.trim()) {
    return bad(`checkout is on "${name}" with a dirty tree — commit or stash it; refusing to recover automatically`);
  }
  const checkout = await run("git", ["checkout", "main"], { cwd: repoRoot });
  if (checkout.code !== 0) return bad(`git checkout main failed: ${checkout.stderr.slice(0, 200)}`);
  const pulled = await run("git", ["pull", "--ff-only"], { cwd: repoRoot });
  if (pulled.code !== 0) return bad(`git pull --ff-only on main failed: ${pulled.stderr.slice(0, 200)}`);
  return { name: "checkout-recovery", ok: true, detail: `recovered checkout to synced main (was stranded on "${name}")` };
}

// The checkpoint is adoptable only when it is unambiguous: checkout on a clean
// synced main, exactly one open PR, and that PR's branch carrying the
// increment's documented prefix. Any other state returns null — the normal path
// then either runs a fresh iteration (idle repo) or fails a preflight gate
// loudly instead of resuming something half-identified.
export async function findResumablePr({ run, repoRoot, increment }) {
  const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
  if (branch.code !== 0 || branch.stdout.trim() !== "main") return null;
  const status = await run("git", ["status", "--porcelain"], { cwd: repoRoot });
  if (status.code !== 0 || status.stdout.trim()) return null;
  const fetched = await run("git", ["fetch", "--quiet", "origin"], { cwd: repoRoot });
  if (fetched.code !== 0) return null;
  const refs = await run("git", ["rev-parse", "main", "origin/main"], { cwd: repoRoot });
  const [local, remote] = refs.stdout.trim().split("\n");
  if (refs.code !== 0 || local !== remote) return null;
  const prs = await run("gh", ["pr", "list", "--state", "open", "--json", "number,headRefName"], { cwd: repoRoot });
  if (prs.code !== 0) return null;
  let open = [];
  try { open = JSON.parse(prs.stdout || "[]"); } catch { return null; }
  if (open.length !== 1) return null;
  const [pr] = open;
  if (typeof pr.headRefName !== "string" || typeof pr.number !== "number") return null;
  if (!pr.headRefName.toLowerCase().startsWith(`${increment.toLowerCase()}-`)) return null;
  return { prNumber: pr.number, headRefName: pr.headRefName };
}
