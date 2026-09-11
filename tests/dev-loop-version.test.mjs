// tests/dev-loop-version.test.mjs — V1 release versioning: the bump gate and
// the merge-path tagging tail. All git/gh interaction is faked; the only real
// file reads are plugin.json-shaped strings passed in directly.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateVersionBump, parseVersion, tagMergedRelease } from "../scripts/dev-loop/version.mjs";

const manifest = (version) => `${JSON.stringify({ name: "z-pr-review", version }, null, 2)}\n`;
const ok = (stdout = "") => async () => ({ code: 0, stdout, stderr: "" });
// The gate reads the PR-branch plugin.json from the working tree, so each case
// materializes one in a temp dir.
const withManifest = (version, fn) => async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "zpr-version-"));
  writeFileSync(join(repoRoot, "plugin.json"), manifest(version));
  await fn(repoRoot);
};

describe("parseVersion", () => {
  it("accepts strict X.Y.Z versions", () => {
    assert.deepEqual(parseVersion(manifest("0.2.0"), "m"), { version: "0.2.0" });
  });
  it("rejects unparseable JSON, missing, and non-X.Y.Z versions", () => {
    assert.match(parseVersion("{oops", "m").error, /not parseable JSON/);
    assert.match(parseVersion("{}", "m").error, /no strict X\.Y\.Z/);
    for (const bad of ["0.1", "1.2.3-rc1", "v1.2.3", "latest", 3]) {
      assert.match(parseVersion(manifest(bad), "m").error, /no strict X\.Y\.Z/);
    }
  });
});

describe("gateVersionBump", () => {
  it("passes when the PR version differs from origin/main's", withManifest("0.2.0", async (repoRoot) => {
    const gate = await gateVersionBump({ run: ok(manifest("0.1.0")), repoRoot });
    assert.deepEqual(gate, { name: "version-bump", ok: true, detail: "version 0.1.0 → 0.2.0" });
  }));
  it("fails when the version is unchanged vs main", withManifest("0.1.0", async (repoRoot) => {
    const gate = await gateVersionBump({ run: ok(manifest("0.1.0")), repoRoot });
    assert.equal(gate.ok, false);
    assert.match(gate.detail, /unchanged vs main/);
  }));
  it("fails closed on git baseline failure", withManifest("0.2.0", async (repoRoot) => {
    const gate = await gateVersionBump({ run: async () => ({ code: 128, stdout: "", stderr: "bad object" }), repoRoot });
    assert.equal(gate.ok, false);
    assert.match(gate.detail, /origin\/main/);
  }));
  it("fails closed on an unparseable baseline", withManifest("0.2.0", async (repoRoot) => {
    const gate = await gateVersionBump({ run: ok("not json"), repoRoot });
    assert.equal(gate.ok, false);
    assert.match(gate.detail, /origin\/main:plugin\.json/);
  }));
  it("fails closed on an invalid PR-branch version", withManifest("0.2.0-rc1", async (repoRoot) => {
    const gate = await gateVersionBump({ run: ok(manifest("0.1.0")), repoRoot });
    assert.equal(gate.ok, false);
    assert.match(gate.detail, /PR branch/);
  }));
});

describe("tagMergedRelease", () => {
  it("tags the merged main vX.Y.Z from plugin.json and pushes it", withManifest("0.3.1", async (repoRoot) => {
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await tagMergedRelease({ run, repoRoot });
    assert.deepEqual(result, { ok: true, detail: "tagged merged main v0.3.1" });
    assert.deepEqual(calls, [["git", "tag", "v0.3.1"], ["git", "push", "origin", "v0.3.1"]]);
  }));
  it("fails closed on tag creation failure (e.g. tag already exists)", withManifest("0.3.1", async (repoRoot) => {
    const run = async (command, args) =>
      args[0] === "tag"
        ? { code: 128, stdout: "", stderr: "already exists" }
        : { code: 0, stdout: "", stderr: "" };
    const result = await tagMergedRelease({ run, repoRoot });
    assert.equal(result.ok, false);
    assert.match(result.detail, /git tag v0\.3\.1 failed/);
  }));
  it("fails closed on push failure", withManifest("0.3.1", async (repoRoot) => {
    const run = async (command, args) =>
      args[0] === "push"
        ? { code: 1, stdout: "", stderr: "rejected" }
        : { code: 0, stdout: "", stderr: "" };
    const result = await tagMergedRelease({ run, repoRoot });
    assert.equal(result.ok, false);
    assert.match(result.detail, /git push origin v0\.3\.1 failed/);
  }));
  it("fails closed on an invalid plugin.json version", withManifest("x", async (repoRoot) => {
    const result = await tagMergedRelease({ run: ok(), repoRoot });
    assert.equal(result.ok, false);
    assert.match(result.detail, /no strict X\.Y\.Z/);
  }));
});
