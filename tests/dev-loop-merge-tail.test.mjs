// tests/dev-loop-merge-tail.test.mjs — the merge path's server-pinned squash
// merge (GraphQL mergePullRequest with expectedHeadOid, so the reviewed head is
// enforced atomically at GitHub) and the tagging tail (merge confirmed, with
// polling through transient OPEN/QUEUED, then checkout main → ff-only pull →
// HEAD must equal this PR's merge commit → tag → push). The wiring in
// scripts/dev-loop.mjs delegates to both and deletes the branch only after the
// tail confirms; all git/gh interaction is faked and the poll delay is stubbed
// to zero.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteMergedBranch, mergeTail, squashMergeAtHead } from "../scripts/dev-loop/merge-tail.mjs";

const MERGE_OID = "a".repeat(40);
const OTHER_OID = "b".repeat(40);
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (stderr) => ({ code: 1, stdout: "", stderr, timedOut: false });
const noSleep = async () => {};
// tagMergedRelease reads plugin.json from the working tree, so each case
// materializes one in a temp dir and removes it afterwards.
const withManifest = (fn) => async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "zpr-mergetail-"));
  try {
    writeFileSync(join(repoRoot, "plugin.json"), `${JSON.stringify({ name: "z-pr-review", version: "0.3.1" }, null, 2)}\n`);
    await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
};
// A run fake whose PR views cycle through the given states (each "MERGED"
// carries the PR's merge commit), whose git rev-parse HEAD reports headOid, and
// whose rev-parse of a tag reports tagOid (the fetch-followed reservation —
// absent by default, so rev-parse fails as it would with no local tag).
const fakeRun = ({ states, headOid = MERGE_OID, tagOid = null } = {}) => {
  const calls = [];
  let view = 0;
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "gh" && args[1] === "view") {
      const state = states[Math.min(view, states.length - 1)];
      view += 1;
      return ok(JSON.stringify(state === "MERGED"
        ? { state: "MERGED", mergeCommit: { oid: MERGE_OID } }
        : { state }));
    }
    if (command === "git" && args[0] === "rev-parse") {
      if (args[1] === "HEAD") return ok(`${headOid}\n`);
      return tagOid ? ok(`${tagOid}\n`) : fail("unknown revision or path not in the working tree");
    }
    return ok();
  };
  return { calls, run };
};

describe("mergeTail", () => {
  it("tags the release only after GitHub confirms MERGED and HEAD is the PR's merge commit", withManifest(async (repoRoot) => {
    const { calls, run } = fakeRun({ states: ["MERGED"] });
    const result = await mergeTail({ run, repoRoot, merged: ok("merged"), prNumber: 23, sleep: noSleep });
    assert.equal(result.code, 0);
    assert.deepEqual(calls, [
      ["gh", "pr", "view", "23", "--json", "state,mergeCommit"],
      ["git", "checkout", "main"],
      ["git", "pull", "--ff-only"],
      ["git", "rev-parse", "HEAD"],
      ["git", "tag", "v0.3.1"],
      ["git", "push", "origin", "v0.3.1"],
    ]);
  }));
  it("retargets the pre-merge tag reservation onto the merge commit (force-with-lease pinned to the reserved OID)", withManifest(async (repoRoot) => {
    const RESERVED_AT = "c".repeat(40);
    const { calls, run } = fakeRun({ states: ["MERGED"], tagOid: RESERVED_AT });
    const result = await mergeTail({ run, repoRoot, merged: ok("merged"), prNumber: 23, reservation: { tag: "v0.3.1", reservedAt: RESERVED_AT }, sleep: noSleep });
    assert.equal(result.code, 0);
    assert.ok(calls.some(([command, ...args]) => command === "git" && args[0] === "tag" && args[1] === "-f" && args[2] === "v0.3.1"),
      "the fetch-followed local copy of our own reservation is replaced at HEAD, not collided with");
    assert.ok(calls.some(([command, ...args]) => command === "git" && args.includes(`--force-with-lease=refs/tags/v0.3.1:${RESERVED_AT}`)),
      "the tail must move only our own reservation, never clobber a moved tag");
  }));
  it("polls through a transient OPEN/QUEUED window instead of giving up", withManifest(async (repoRoot) => {
    const { calls, run } = fakeRun({ states: ["OPEN", "QUEUED", "MERGED"] });
    const sleeps = [];
    const result = await mergeTail({ run, repoRoot, merged: ok("merged"), prNumber: 23, sleep: async (ms) => sleeps.push(ms) });
    assert.equal(result.code, 0);
    assert.equal(calls.filter(([command]) => command === "gh").length, 3, "must re-view until MERGED");
    assert.deepEqual(sleeps, [10000, 10000], "must wait between polls");
    assert.ok(calls.some(([, ...args]) => args.includes("v0.3.1")), "must eventually tag");
  }));
  it("fails closed (after polling) when GitHub never confirms MERGED", withManifest(async (repoRoot) => {
    const { calls, run } = fakeRun({ states: ["OPEN"] });
    const result = await mergeTail({ run, repoRoot, merged: ok("merged"), prNumber: 23, sleep: noSleep });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not confirmed MERGED/);
    assert.match(result.stderr, /30 attempts/);
    assert.match(result.stderr, /release tag was NOT created/, "must disclose the tag was not created");
    assert.ok(!calls.some(([command, , arg]) => command === "git" && arg === "v0.3.1"), "must not tag");
  }));
  it("fails closed (after polling) when gh pr view itself keeps failing", withManifest(async (repoRoot) => {
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, ...args]);
      return command === "gh" && args[1] === "view" ? fail("gh down") : ok();
    };
    const result = await mergeTail({ run, repoRoot, merged: ok("merged"), prNumber: 23, sleep: noSleep });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not confirmed MERGED/);
  }));
  it("fails closed when MERGED arrives without a mergeCommit oid", withManifest(async (repoRoot) => {
    const run = async (command, args) =>
      command === "gh" && args[1] === "view" ? ok(JSON.stringify({ state: "MERGED" })) : ok();
    const result = await mergeTail({ run, repoRoot, merged: ok("merged"), prNumber: 23, sleep: noSleep });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not confirmed MERGED/);
  }));
  it("fails fast on terminal CLOSED instead of burning the whole poll window (run-3 independent P2)", withManifest(async (repoRoot) => {
    const views = [];
    const run = async (command, args) => {
      if (command === "gh" && args[1] === "view") {
        views.push(1);
        return ok(JSON.stringify({ state: "CLOSED" }));
      }
      return ok();
    };
    const result = await mergeTail({ run, repoRoot, merged: ok("merged"), prNumber: 23, sleep: noSleep });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /CLOSED, not MERGED/);
    assert.equal(views.length, 1, "must not keep polling a terminal state");
  }));
  it("aborts before tagging when git checkout main fails", withManifest(async (repoRoot) => {
    const { calls, run } = fakeRun({ states: ["MERGED"] });
    const wrapped = async (command, args) =>
      command === "git" && args[0] === "checkout" ? fail("dirty tree") : run(command, args);
    const result = await mergeTail({ run: wrapped, repoRoot, merged: ok("merged"), prNumber: 23, sleep: noSleep });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /git checkout main failed/);
    assert.ok(!calls.some(([command, arg0]) => command === "git" && arg0 === "pull"), "must not pull after failed checkout");
  }));
  it("aborts before tagging when the ff-only pull fails", withManifest(async (repoRoot) => {
    const { calls, run } = fakeRun({ states: ["MERGED"] });
    const wrapped = async (command, args) =>
      command === "git" && args[0] === "pull" ? fail("not fast-forward") : run(command, args);
    const result = await mergeTail({ run: wrapped, repoRoot, merged: ok("merged"), prNumber: 23, sleep: noSleep });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /git pull --ff-only failed/);
    assert.ok(!calls.some(([command, , arg]) => command === "git" && arg === "v0.3.1"), "must not tag");
  }));
  it("refuses to tag when another merge landed first (HEAD ≠ this PR's merge commit)", withManifest(async (repoRoot) => {
    const { calls, run } = fakeRun({ states: ["MERGED"], headOid: OTHER_OID });
    const result = await mergeTail({ run, repoRoot, merged: ok("merged"), prNumber: 23, sleep: noSleep });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /is not PR 23's merge commit/);
    assert.ok(!calls.some(([command, , arg]) => command === "git" && arg === "v0.3.1"), "must not tag the wrong commit");
  }));
  it("surfaces a tag failure as a merge-path failure without un-merging", withManifest(async (repoRoot) => {
    const { run } = fakeRun({ states: ["MERGED"] });
    const wrapped = async (command, args) =>
      command === "git" && args[0] === "tag" ? fail("already exists") : run(command, args);
    const result = await mergeTail({ run: wrapped, repoRoot, merged: ok("merged"), prNumber: 23, sleep: noSleep });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /release tag failed/);
  }));
});

describe("squashMergeAtHead", () => {
  const HEAD = "c".repeat(40);
  // A run fake for the merge path: `gh pr view` resolves the GraphQL id and
  // branch, `gh api graphql` performs (or refuses) the pinned mutation.
  const mergeFake = ({ graphql = { data: { mergePullRequest: { pullRequest: { mergeCommit: { oid: MERGE_OID } } } } }, graphqlRaw = null, overrides = {} } = {}) => {
    const calls = [];
    const run = async (command, args) => {
      const key = [command, ...args].join(" ");
      calls.push(key);
      if (overrides[key]) return overrides[key];
      if (command === "gh" && args[1] === "view") {
        return ok(JSON.stringify({ id: "PR_23", headRefName: "i9-example", isCrossRepository: false }));
      }
      if (command === "gh" && args[0] === "api") return ok(graphqlRaw ?? JSON.stringify(graphql));
      return ok();
    };
    return { calls, run };
  };
  it("merges via the GraphQL mutation pinned to the reviewed head (expectedHeadOid), returning the branch for post-confirmation deletion", async () => {
    const { calls, run } = mergeFake();
    const result = await squashMergeAtHead({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: HEAD });
    assert.equal(result.code, 0);
    const graphql = calls.find((key) => key.startsWith("gh api graphql"));
    assert.ok(graphql, "must call the GraphQL mergePullRequest mutation");
    assert.match(graphql, /mergePullRequest/, "the mutation must be mergePullRequest");
    // MergePullRequestInput has expectedHeadOid — an earlier draft used
    // `headRefOid`, a field that does not exist in the schema, which every
    // real merge attempt would have died on (run-3 dogfood P1; the fake run
    // cannot schema-check, so the assertion pins the field name).
    assert.match(graphql, /expectedHeadOid/, "the mutation must pin via expectedHeadOid");
    assert.doesNotMatch(graphql, /headRefOid/, "headRefOid is not a MergePullRequestInput field");
    assert.ok(graphql.includes(`head=${HEAD}`), "the pinned head is the reviewed OID");
    assert.equal(result.branch, "i9-example", "the branch is returned for the merge dep to delete only after confirmation");
    assert.equal(result.isCrossRepository, false, "fork status is returned so deletion never targets the wrong remote");
    assert.equal(result.mergeCommitOid, MERGE_OID);
    assert.ok(!calls.some((key) => key.includes("--delete")), "must NOT delete the branch before the merge is confirmed");
  });
  it("aborts when GitHub refuses the mutation because the head moved (atomic server-side pin)", async () => {
    const { calls, run } = mergeFake({ graphql: { errors: [{ message: "Head branch was modified. Try and perform the merge again." }] } });
    const result = await squashMergeAtHead({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: HEAD });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /merge aborted/);
    assert.match(result.stderr, /Head branch was modified/);
    assert.ok(!calls.some((key) => key.includes("--delete")), "must not delete the branch of a refused merge");
  });
  it("fails closed when data.mergePullRequest arrives WITHOUT a mergeCommit oid (that is not a confirmed merge)", async () => {
    const { calls, run } = mergeFake({ graphql: { data: { mergePullRequest: { pullRequest: { mergeCommit: null } } } } });
    const result = await squashMergeAtHead({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: HEAD });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /did not confirm the squash-merge/);
    assert.ok(!calls.some((key) => key.includes("--delete")), "must not delete the branch on unconfirmed merges");
  });
  it("fails closed when the PR's GraphQL id / branch cannot be resolved", async () => {
    const { run } = mergeFake({ overrides: { "gh pr view 23 --json id,headRefName,isCrossRepository": fail("gh down") } });
    const result = await squashMergeAtHead({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: HEAD });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cannot resolve PR 23/);
  });
  it("fails closed when the fork status is missing (deletion must never guess which remote owns the branch)", async () => {
    const { run } = mergeFake({ overrides: { "gh pr view 23 --json id,headRefName,isCrossRepository": ok(JSON.stringify({ id: "PR_23", headRefName: "i9-example" })) } });
    const result = await squashMergeAtHead({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: HEAD });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cannot resolve PR 23.*fork status/);
  });
  it("fails closed when the GraphQL output is not JSON", async () => {
    const { run } = mergeFake({ graphqlRaw: "not json" });
    const result = await squashMergeAtHead({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: HEAD });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /merge aborted/);
  });
});

describe("deleteMergedBranch", () => {
  it("deletes the branch on the remote and prunes the local branch (--delete-branch parity)", async () => {
    const calls = [];
    const run = async (command, args) => { calls.push([command, ...args]); return ok(); };
    const result = await deleteMergedBranch({ run, repoRoot: "/tmp/any", branch: "i9-example", isCrossRepository: false });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls, [["git", "push", "origin", "--delete", "i9-example"], ["git", "branch", "-D", "i9-example"]]);
  });
  it("never deletes a fork PR's branch through the base repository remote (run-3 P1)", async () => {
    const calls = [];
    const run = async (command, args) => { calls.push([command, ...args]); return ok(); };
    const result = await deleteMergedBranch({ run, repoRoot: "/tmp/any", branch: "i9-example", isCrossRepository: true });
    assert.equal(result.ok, true, "a fork skip is the correct outcome, not a warning");
    assert.match(result.note, /lives in the PR author's fork/);
    assert.ok(!calls.some(([command, , flag]) => command === "git" && flag === "--delete"), "must not push --delete through the base remote for a fork branch");
    assert.deepEqual(calls, [["git", "branch", "-D", "i9-example"]], "the local branch is still pruned");
  });
  it("treats a missing local branch as fine, not debris (fork PR never checked out here)", async () => {
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, ...args]);
      return command === "git" && args[0] === "branch" ? fail("error: branch 'i9-example' not found.") : ok();
    };
    const result = await deleteMergedBranch({ run, repoRoot: "/tmp/any", branch: "i9-example", isCrossRepository: true });
    assert.equal(result.ok, true);
  });
  it("reports a disclosed warning (not a failure) when the remote deletion fails — it cannot un-merge", async () => {
    const run = async (command, args) =>
      command === "git" && args[0] === "push" ? fail("remote ref delete failed") : ok();
    const result = await deleteMergedBranch({ run, repoRoot: "/tmp/any", branch: "i9-example", isCrossRepository: false });
    assert.equal(result.ok, false);
    assert.match(result.detail, /remote branch i9-example was not deleted/);
  });
  it("discloses a local-prune failure without failing the merge", async () => {
    const run = async (command, args) =>
      command === "git" && args[0] === "branch" ? fail("error: Cannot delete branch") : ok();
    const result = await deleteMergedBranch({ run, repoRoot: "/tmp/any", branch: "i9-example", isCrossRepository: false });
    assert.equal(result.ok, false);
    assert.match(result.detail, /local branch i9-example was not deleted/);
  });
});
