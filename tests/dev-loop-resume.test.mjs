// tests/dev-loop-resume.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findResumablePr, recoverCheckout } from "../scripts/dev-loop/resume.mjs";

const repoRoot = "/repo"; // never touched: all commands are faked

// Dispatches per command like the gates tests: one canned stdout cannot express
// a multi-step probe, so the fake answers by exact argv.
const fakeRun = (outputs = {}, defaults = {}) => async (command, args) => {
  const key = `${command} ${args.join(" ")}`;
  const result = outputs[key] ?? defaults[key];
  if (result) return typeof result === "function" ? result() : result;
  return { code: 0, stdout: "", stderr: "" };
};

const onBranch = (name) => ({
  "git rev-parse --abbrev-ref HEAD": { code: 0, stdout: `${name}\n`, stderr: "" },
});

describe("recoverCheckout", () => {
  it("does nothing on main", async () => {
    const calls = [];
    const run = async (command, args) => { calls.push([command, ...args]); return { code: 0, stdout: "main\n", stderr: "" }; };
    assert.equal(await recoverCheckout({ run, repoRoot }), null);
    assert.deepEqual(calls, [["git", "rev-parse", "--abbrev-ref", "HEAD"]]);
  });
  it("does not touch a non-increment branch (repo-idle reports it loudly as before)", async () => {
    const run = fakeRun(onBranch("experiment-thing"));
    assert.equal(await recoverCheckout({ run, repoRoot }), null);
  });
  it("recovers a clean increment-branch checkout to synced main", async () => {
    const run = fakeRun({ ...onBranch("i4-topologies-tiers") });
    const result = await recoverCheckout({ run, repoRoot });
    assert.equal(result.ok, true);
    assert.match(result.detail, /was stranded on "i4-topologies-tiers"/);
  });
  it("fails closed on a dirty tree, git failures, or a non-ff pull", async () => {
    const cases = [
      fakeRun({ ...onBranch("i4-x"), "git status --porcelain": { code: 0, stdout: " M file\n", stderr: "" } }),
      fakeRun({ ...onBranch("i4-x"), "git status --porcelain": { code: 1, stdout: "", stderr: "boom" } }),
      fakeRun({ ...onBranch("i4-x"), "git checkout main": { code: 1, stdout: "", stderr: "boom" } }),
      fakeRun({ ...onBranch("i4-x"), "git pull --ff-only": { code: 1, stdout: "", stderr: "not ff" } }),
    ];
    for (const run of cases) {
      const result = await recoverCheckout({ run, repoRoot });
      assert.equal(result.ok, false);
      assert.equal(result.name, "checkout-recovery");
    }
  });
});

describe("findResumablePr", () => {
  const adoptable = {
    "git rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n", stderr: "" },
    "git rev-parse main origin/main": { code: 0, stdout: "sha-a\nsha-a\n", stderr: "" },
    "gh pr list --state open --json number,headRefName": {
      code: 0, stdout: '[{"number":18,"headRefName":"i4-topologies-tiers"}]', stderr: "",
    },
  };
  it("adopts the single open PR whose branch carries the increment prefix", async () => {
    assert.deepEqual(await findResumablePr({ run: fakeRun(adoptable), repoRoot, increment: "I4" }), {
      prNumber: 18, headRefName: "i4-topologies-tiers",
    });
  });
  it("returns null for any ambiguous or unsuitable state", async () => {
    const cases = [
      fakeRun({ ...adoptable, "git rev-parse --abbrev-ref HEAD": { code: 0, stdout: "i4-topologies-tiers\n", stderr: "" } }),
      fakeRun({ ...adoptable, "git status --porcelain": { code: 0, stdout: " M file\n", stderr: "" } }),
      fakeRun({ ...adoptable, "git fetch --quiet origin": { code: 1, stdout: "", stderr: "network" } }),
      fakeRun({ ...adoptable, "git rev-parse main origin/main": { code: 0, stdout: "aaa\nbbb\n", stderr: "" } }),
      fakeRun({ ...adoptable, "gh pr list --state open --json number,headRefName": { code: 1, stdout: "", stderr: "gh down" } }),
      fakeRun({ ...adoptable, "gh pr list --state open --json number,headRefName": { code: 0, stdout: "[]", stderr: "" } }),
      fakeRun({ ...adoptable, "gh pr list --state open --json number,headRefName": { code: 0, stdout: "not json", stderr: "" } }),
      fakeRun({
        ...adoptable,
        "gh pr list --state open --json number,headRefName": {
          code: 0, stdout: '[{"number":19,"headRefName":"v1-semver"},{"number":20,"headRefName":"i4-x"}]', stderr: "",
        },
      }),
    ];
    for (const run of cases) {
      assert.equal(await findResumablePr({ run, repoRoot, increment: "I4" }), null);
    }
  });
  it("returns null when the only open PR is another increment's (prefix mismatch)", async () => {
    const run = fakeRun({
      ...adoptable,
      "gh pr list --state open --json number,headRefName": {
        code: 0, stdout: '[{"number":19,"headRefName":"v1-semver"}]', stderr: "",
      },
    });
    assert.equal(await findResumablePr({ run, repoRoot, increment: "I4" }), null);
  });
});
