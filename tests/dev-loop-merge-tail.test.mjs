// tests/dev-loop-merge-tail.test.mjs — the merge-path tagging tail (merge
// confirmed → checkout main → ff-only pull → tag → push). The wiring in
// scripts/dev-loop.mjs delegates to mergeTail, which composes the same steps
// main() previously inlined; all git/gh interaction is faked.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeTail } from "../scripts/dev-loop/merge-tail.mjs";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (stderr) => ({ code: 1, stdout: "", stderr, timedOut: false });
// tagMergedRelease reads plugin.json from the working tree, so each case
// materializes one in a temp dir.
const withManifest = (fn) => async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "zpr-mergetail-"));
  writeFileSync(join(repoRoot, "plugin.json"), `${JSON.stringify({ name: "z-pr-review", version: "0.3.1" }, null, 2)}\n`);
  await fn(repoRoot);
};

describe("mergeTail", () => {
  it("tags the release only after GitHub confirms MERGED and main syncs", withManifest(async (repoRoot) => {
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "gh" && args[1] === "view") return ok(JSON.stringify({ state: "MERGED" }));
      return ok();
    };
    const result = await mergeTail({ run, repoRoot, merged: ok("merged"), prNumber: 23 });
    assert.equal(result.code, 0);
    assert.deepEqual(calls, [
      ["gh", "pr", "view", "23", "--json", "state"],
      ["git", "checkout", "main"],
      ["git", "pull", "--ff-only"],
      ["git", "tag", "v0.3.1"],
      ["git", "push", "origin", "v0.3.1"],
    ]);
  }));
  it("aborts before tagging when GitHub does not confirm MERGED", withManifest(async (repoRoot) => {
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "gh" && args[1] === "view") return ok(JSON.stringify({ state: "OPEN" }));
      return ok();
    };
    const result = await mergeTail({ run, repoRoot, merged: ok("merged"), prNumber: 23 });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not confirmed MERGED/);
    assert.ok(!calls.some(([command, , arg]) => command === "git" && arg === "v0.3.1"), "must not tag");
  }));
  it("aborts before tagging when gh pr view itself fails", withManifest(async (repoRoot) => {
    const run = async (command, args) =>
      command === "gh" && args[1] === "view" ? fail("gh down") : ok();
    const result = await mergeTail({ run, repoRoot, merged: ok("merged"), prNumber: 23 });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not confirmed MERGED/);
  }));
  it("aborts before tagging when git checkout main fails", withManifest(async (repoRoot) => {
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "git" && args[0] === "checkout") return fail("dirty tree");
      if (command === "gh" && args[1] === "view") return ok(JSON.stringify({ state: "MERGED" }));
      return ok();
    };
    const result = await mergeTail({ run, repoRoot, merged: ok("merged"), prNumber: 23 });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /git checkout main failed/);
    assert.ok(!calls.some(([, ...args]) => args.includes("pull")), "must not pull after failed checkout");
  }));
  it("aborts before tagging when the ff-only pull fails", withManifest(async (repoRoot) => {
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "git" && args[0] === "pull") return fail("not fast-forward");
      if (command === "gh" && args[1] === "view") return ok(JSON.stringify({ state: "MERGED" }));
      return ok();
    };
    const result = await mergeTail({ run, repoRoot, merged: ok("merged"), prNumber: 23 });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /git pull --ff-only failed/);
    assert.ok(!calls.some(([command, , arg]) => command === "git" && arg === "v0.3.1"), "must not tag");
  }));
  it("surfaces a tag failure as a merge-path failure without un-merging", withManifest(async (repoRoot) => {
    const run = async (command, args) => {
      if (command === "gh" && args[1] === "view") return ok(JSON.stringify({ state: "MERGED" }));
      if (command === "git" && args[0] === "tag") return fail("already exists");
      return ok();
    };
    const result = await mergeTail({ run, repoRoot, merged: ok("merged"), prNumber: 23 });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /release tag failed/);
  }));
});
