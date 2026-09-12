// tests/dev-loop-version.test.mjs — V1 release versioning: the bump gate and
// the merge-path tagging tail. All git/gh interaction is faked; the only real
// file reads are plugin.json-shaped strings passed in directly.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, gateVersionBump, parseVersion, tagMergedRelease, verifyBumpAtMerge } from "../scripts/dev-loop/version.mjs";

const manifest = (version) => `${JSON.stringify({ name: "z-pr-review", version }, null, 2)}\n`;
const ok = (stdout = "") => async () => ({ code: 0, stdout, stderr: "" });
// The gate reads the PR-branch plugin.json from the working tree, so each case
// materializes one in a temp dir and removes it afterwards.
const withManifest = (version, fn) => async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "zpr-version-"));
  try {
    writeFileSync(join(repoRoot, "plugin.json"), manifest(version));
    await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
};
// Cases that need an empty dir (no manifest at all).
const withEmptyDir = (fn) => async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "zpr-version-"));
  try {
    await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
};

describe("parseVersion", () => {
  it("accepts strict X.Y.Z versions", () => {
    assert.deepEqual(parseVersion(manifest("0.2.0"), "m"), { version: "0.2.0" });
  });
  it("rejects unparseable JSON, missing, and non-X.Y.Z versions", () => {
    assert.match(parseVersion("{oops", "m").error, /not parseable JSON/);
    assert.match(parseVersion("{}", "m").error, /no strict X\.Y\.Z/);
    for (const bad of ["0.1", "1.2.3-rc1", "v1.2.3", "latest", 3, "01.2.3", "1.02.3", "1.2.03", "1.2.3\n", "1.2.3 ", "1.2.3\nx"]) {
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
  it("fails when the version is a downgrade vs main", withManifest("0.1.0", async (repoRoot) => {
    const gate = await gateVersionBump({ run: ok(manifest("0.2.0")), repoRoot });
    assert.equal(gate.ok, false);
    assert.match(gate.detail, /not greater/);
  }));
  it("compares numerically, not lexically (0.10.0 > 0.9.0)", withManifest("0.10.0", async (repoRoot) => {
    const gate = await gateVersionBump({ run: ok(manifest("0.9.0")), repoRoot });
    assert.equal(gate.ok, true);
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
  it("fails closed (as a failed gate, not a crash) when the PR manifest is unreadable", withEmptyDir(async (repoRoot) => {
    const gate = await gateVersionBump({ run: ok(manifest("0.1.0")), repoRoot });
    assert.equal(gate.ok, false);
    assert.match(gate.detail, /PR branch.*cannot be read/);
  }));
});

describe("compareVersions", () => {
  it("keeps ordering for numeric identifiers beyond 2^53 (no float collapse)", () => {
    // 2^53 + 1 vs 2^53: equal as Numbers, distinct as semver identifiers.
    assert.equal(compareVersions("0.1.9007199254740993", "0.1.9007199254740992"), 1);
    assert.equal(compareVersions("0.1.9007199254740992", "0.1.9007199254740993"), -1);
    assert.equal(compareVersions("0.1.9007199254740993", "0.1.9007199254740993"), 0);
    // Length-first comparison, not lexical: "10" > "9" even though "1" < "9".
    assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  });
});

describe("verifyBumpAtMerge", () => {
  // All input reaches the helper through git/gh (fetch, pr view, show), so a
  // dispatching fake covers every case without touching the working tree.
  // (Local `res` because the file-level `ok` is a run factory, not a result.)
  const res = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr });
  const OID = "c".repeat(40);
  const fake = ({ main = "0.1.0", head = "0.2.0", overrides = {} } = {}) => {
    const calls = [];
    const run = async (command, args) => {
      const key = [command, ...args].join(" ");
      calls.push(key);
      if (overrides[key]) return overrides[key];
      if (key === "git show origin/main:plugin.json") return res(manifest(main));
      if (key === "git show HEAD:plugin.json") return res(manifest(head));
      if (command === "gh" && args[1] === "view") return res(JSON.stringify({ headRefOid: OID }));
      if (command === "git" && args[0] === "show") return res(manifest(head));
      return res();
    };
    return { calls, run };
  };
  it("confirms the bump against a freshly fetched main, reading the PR head by its pinned remote OID", async () => {
    const { calls, run } = fake({ main: "0.1.0", head: "0.2.0" });
    const result = await verifyBumpAtMerge({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: OID });
    assert.deepEqual(result, { ok: true, tag: "v0.2.0", reservedAt: OID, detail: `version 0.1.0 → 0.2.0 confirmed at merge time (PR head ${OID.slice(0, 7)}, release tag v0.2.0 reserved on origin at ${OID.slice(0, 7)})` });
    assert.ok(calls.includes(`git show ${OID}:plugin.json`), "must read the PR head manifest by OID, not the local checkout");
    assert.ok(!calls.includes("git show HEAD:plugin.json"), "the local checkout is never the re-check source");
    assert.ok(calls.includes("git ls-remote --tags origin refs/tags/v0.2.0"),
      "must check the release tag on origin before merging (duplicate-version guard)");
    assert.ok(calls.includes(`git push origin ${OID}:refs/tags/v0.2.0`),
      "must atomically reserve the release tag on origin before the merge (concurrent-run guard)");
  });
  it("aborts the merge when the atomic tag reservation is rejected — a concurrent run released the same version (round-5 P1)", async () => {
    const { run } = fake({ main: "0.1.0", head: "0.2.0", overrides: { [`git push origin ${OID}:refs/tags/v0.2.0`]: res("", 1, " ! [rejected] refs/tags/v0.2.0 -> refs/tags/v0.2.0 (already exists)") } });
    const result = await verifyBumpAtMerge({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: OID });
    assert.equal(result.ok, false);
    assert.match(result.detail, /reserving release tag v0\.2\.0 on origin failed/);
    assert.match(result.detail, /merge aborted/);
    assert.match(result.detail, /concurrently/);
  });
  it("aborts the merge when the release tag already exists on origin (duplicate version)", async () => {
    const { run } = fake({ main: "0.1.0", head: "0.2.0", overrides: { "git ls-remote --tags origin refs/tags/v0.2.0": res("abc123\trefs/tags/v0.2.0\n") } });
    const result = await verifyBumpAtMerge({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: OID });
    assert.equal(result.ok, false);
    assert.match(result.detail, /release tag v0\.2\.0 already exists on origin/);
    assert.match(result.detail, /merge aborted/);
  });
  it("fails closed when the origin tag check itself fails", async () => {
    const { run } = fake({ overrides: { "git ls-remote --tags origin refs/tags/v0.2.0": res("", 1, "network") } });
    const result = await verifyBumpAtMerge({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: OID });
    assert.equal(result.ok, false);
    assert.match(result.detail, /git ls-remote --tags origin v0\.2\.0 failed/);
    assert.match(result.detail, /merge aborted/);
  });
  it("aborts the merge when the head at re-check time differs from the pinned reviewed head", async () => {
    const OTHER = "d".repeat(40);
    const { run } = fake({ main: "0.1.0", head: "0.2.0", overrides: { "gh pr view 23 --json headRefOid": res(JSON.stringify({ headRefOid: OTHER })) } });
    const result = await verifyBumpAtMerge({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: OID });
    assert.equal(result.ok, false);
    assert.match(result.detail, /pinned the reviewed head/);
    assert.match(result.detail, /merge aborted/);
  });
  it("aborts the merge when main moved to the PR's version (stale gate baseline)", async () => {
    const { run } = fake({ main: "0.2.0", head: "0.2.0" });
    const result = await verifyBumpAtMerge({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: OID });
    assert.equal(result.ok, false);
    assert.match(result.detail, /unchanged vs main's 0\.2\.0 at merge time/);
    assert.match(result.detail, /merge aborted/);
  });
  it("aborts the merge when main moved past the PR's version", async () => {
    const { run } = fake({ main: "0.3.0", head: "0.2.0" });
    const result = await verifyBumpAtMerge({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: OID });
    assert.equal(result.ok, false);
    assert.match(result.detail, /not greater than main's 0\.3\.0 at merge time/);
  });
  it("fails closed when the fetch fails", async () => {
    const { run } = fake({ overrides: { "git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main": res("", 1, "network") } });
    const result = await verifyBumpAtMerge({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: OID });
    assert.equal(result.ok, false);
    assert.match(result.detail, /git fetch origin main failed/);
  });
  it("fetches with an explicit refspec that updates origin/main (a bare `fetch origin main` would leave the stale baseline in place)", async () => {
    const { calls, run } = fake({ main: "0.1.0", head: "0.2.0" });
    await verifyBumpAtMerge({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: OID });
    assert.ok(calls.some((key) => key.startsWith("git fetch") && key.includes("+refs/heads/main:refs/remotes/origin/main")),
      "the fetch must update refs/remotes/origin/main itself, not just FETCH_HEAD");
  });
  it("fails closed when the PR head cannot be pinned (gh view fails or OID malformed)", async () => {
    const ghDown = fake({ overrides: { "gh pr view 23 --json headRefOid": res("", 1, "gh down") } });
    const unpinned = fake({ overrides: { "gh pr view 23 --json headRefOid": res(JSON.stringify({ headRefOid: "short" })) } });
    for (const { run } of [ghDown, unpinned]) {
      const result = await verifyBumpAtMerge({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: OID });
      assert.equal(result.ok, false);
      assert.match(result.detail, /cannot pin PR 23 headRefOid/);
    }
  });
  it("fails closed when main's manifest cannot be read at merge time", async () => {
    const { run } = fake({ overrides: { "git show origin/main:plugin.json": res("", 128, "bad object") } });
    const result = await verifyBumpAtMerge({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: OID });
    assert.equal(result.ok, false);
    assert.match(result.detail, /cannot read plugin\.json on origin\/main/);
  });
  it("fails closed when the PR head's manifest is not valid semver", async () => {
    const { run } = fake({ overrides: { [`git show ${OID}:plugin.json`]: res("not json") } });
    const result = await verifyBumpAtMerge({ run, repoRoot: "/tmp/any", prNumber: 23, expectedHeadRefOid: OID });
    assert.equal(result.ok, false);
    assert.match(result.detail, /not parseable JSON/);
  });
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
  it("fails closed on push failure and removes the local tag for retry", withManifest("0.3.1", async (repoRoot) => {
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, ...args]);
      return args[0] === "push"
        ? { code: 1, stdout: "", stderr: "rejected" }
        : { code: 0, stdout: "", stderr: "" };
    };
    const result = await tagMergedRelease({ run, repoRoot });
    assert.equal(result.ok, false);
    assert.match(result.detail, /git push origin v0\.3\.1 failed/);
    assert.deepEqual(calls, [["git", "tag", "v0.3.1"], ["git", "push", "origin", "v0.3.1"], ["git", "tag", "-d", "v0.3.1"]]);
  }));
  it("fails closed on an invalid plugin.json version", withManifest("x", async (repoRoot) => {
    const result = await tagMergedRelease({ run: ok(), repoRoot });
    assert.equal(result.ok, false);
    assert.match(result.detail, /no strict X\.Y\.Z/);
  }));
  it("fails closed with the documented release-tag failure when main's manifest is unreadable", withEmptyDir(async (repoRoot) => {
    const result = await tagMergedRelease({ run: ok(), repoRoot });
    assert.equal(result.ok, false);
    assert.match(result.detail, /plugin\.json \(main\) cannot be read/);
    assert.ok(result.detail.length > 0);
  }));
  it("discloses a failed local-tag delete after a failed push (retry must know)", withManifest("0.3.1", async (repoRoot) => {
    const run = async (command, args) =>
      args[0] === "push"
        ? { code: 1, stdout: "", stderr: "rejected" }
        : args[0] === "tag" && args[1] === "-d"
          ? { code: 1, stdout: "", stderr: "no such tag" }
          : { code: 0, stdout: "", stderr: "" };
    const result = await tagMergedRelease({ run, repoRoot });
    assert.equal(result.ok, false);
    assert.match(result.detail, /git push origin v0\.3\.1 failed/);
    assert.match(result.detail, /removing the un-pushed local tag failed/);
  }));
  it("retargets the pre-merge reservation onto the merge commit with a force-with-lease pinned to the reserved OID (round-5 P1)", withManifest("0.3.1", async (repoRoot) => {
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    const RESERVED_AT = "c".repeat(40);
    const result = await tagMergedRelease({ run, repoRoot, reservation: { tag: "v0.3.1", reservedAt: RESERVED_AT } });
    assert.deepEqual(result, { ok: true, detail: "tagged merged main v0.3.1" });
    assert.deepEqual(calls, [
      ["git", "tag", "v0.3.1"],
      ["git", "push", `--force-with-lease=refs/tags/v0.3.1:${RESERVED_AT}`, "origin", "v0.3.1"],
    ], "the push may only move a tag that still sits at our own reservation");
  }));
  it("refuses to retarget a reservation whose tag does not match main's version", withManifest("0.3.1", async (repoRoot) => {
    const calls = [];
    const result = await tagMergedRelease({ run: async (c, a) => (calls.push([c, ...a]), { code: 0, stdout: "", stderr: "" }), repoRoot, reservation: { tag: "v0.9.9", reservedAt: "c".repeat(40) } });
    assert.equal(result.ok, false);
    assert.match(result.detail, /does not match main's version/);
    assert.deepEqual(calls, [], "must not touch any tag on a mismatched reservation");
  }));
  it("fails closed when the force-with-lease retarget is rejected (the tag moved off our reservation)", withManifest("0.3.1", async (repoRoot) => {
    const run = async (command, args) =>
      args[0] === "push"
        ? { code: 1, stdout: "", stderr: "stale info" }
        : { code: 0, stdout: "", stderr: "" };
    const result = await tagMergedRelease({ run, repoRoot, reservation: { tag: "v0.3.1", reservedAt: "c".repeat(40) } });
    assert.equal(result.ok, false);
    assert.match(result.detail, /git push origin v0\.3\.1 failed/);
  }));
});
