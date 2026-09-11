// tests/dev-loop-merge-tail.test.mjs — the merge-path tagging tail (merge
// confirmed, with polling through transient OPEN/QUEUED, then checkout main →
// ff-only pull → HEAD must equal this PR's merge commit → tag → push). The
// wiring in scripts/dev-loop.mjs delegates to mergeTail; all git/gh interaction
// is faked and the poll delay is stubbed to zero.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeTail } from "../scripts/dev-loop/merge-tail.mjs";

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
// carries the PR's merge commit) and whose git rev-parse HEAD reports headOid.
const fakeRun = ({ states, headOid = MERGE_OID } = {}) => {
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
    if (command === "git" && args[0] === "rev-parse") return ok(`${headOid}\n`);
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
    assert.match(result.stderr, /12 attempts/);
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
