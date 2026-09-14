// tests/dev-loop-marketplace.test.mjs — R45, the loop-owned marketplace
// release-publication step (scripts/dev-loop/marketplace.mjs): after the merge
// tail pushes the release tag, the entry in xpepper/copilot-plugins is bumped
// (version + source.ref together) via the GitHub contents API — one entry-scoped
// commit, siblings never stomped, one fresh-refetch retry on rejection (the
// API equivalent of pull --rebase), and a fail-loudly tag-existence check:
// the entry must never point at a ref that does not exist. All git/gh/network
// interaction is faked; applyEntryBump and highestReleaseVersion are pure.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEntryBump, bumpMarketplaceEntry, highestReleaseVersion } from "../scripts/dev-loop/marketplace.mjs";
import { parseVersion } from "../scripts/dev-loop/version.mjs";

// Mirrors the live manifest's shape (canonical JSON.stringify(…, null, 2) with
// a trailing newline — verified 2026-09-15), with a sibling entry that must
// survive every bump byte-for-byte.
const manifestText = (pluginVersion, siblingVersion = "0.4.0") => `${JSON.stringify({
  name: "xpepper-copilot-plugins",
  metadata: { description: "Marketplace index for Pietro Di Bello's GitHub Copilot CLI plugins", version: "0.1.0" },
  owner: { name: "Pietro Di Bello", email: "pierodibello@gmail.com" },
  plugins: [
    {
      name: "z-pr-review",
      description: "Parallel tiered pull-request review for GitHub Copilot CLI (port of pi-pr-review): code-owned gates, host-validated findings, gated COMMENT publication.",
      version: pluginVersion,
      author: { name: "Pietro Di Bello", url: "https://github.com/xpepper" },
      homepage: "https://github.com/xpepper/pr-review-glm",
      keywords: ["pr-review", "code-review", "copilot", "github", "tiered-review"],
      license: "MIT",
      repository: "https://github.com/xpepper/pr-review-glm",
      source: { source: "github", repo: "xpepper/pr-review-glm", path: ".", ref: `v${pluginVersion}` },
    },
    {
      name: "gem-pr-review",
      description: "Parallel, multi-lens AI code review for GitHub pull requests.",
      version: siblingVersion,
      author: { name: "Pietro Di Bello", url: "https://github.com/xpepper" },
      homepage: "https://github.com/xpepper/pr-review-gemini",
      keywords: ["copilot", "pr-review", "code-review"],
      license: "MIT",
      repository: "https://github.com/xpepper/pr-review-gemini",
      source: { source: "github", repo: "xpepper/pr-review-gemini", path: ".", ref: `v${siblingVersion}` },
    },
  ],
}, null, 2)}\n`;

describe("highestReleaseVersion", () => {
  it("picks the highest vX.Y.Z numerically (0.10.0 > 0.9.0, 0.2.10 > 0.2.7)", () => {
    assert.deepEqual(highestReleaseVersion(["v0.2.7", "v0.2.10", "v0.9.0", "v0.10.0"]), { version: "0.10.0" });
  });
  it("ignores non-release tag shapes (prerelease, leading zeros, non-v, junk)", () => {
    const names = ["v1.2.3-rc1", "v01.2.3", "v1.2.3\n", "main", "latest", "v0.2.7", "release-0.2.6", "", null, 3, undefined];
    assert.deepEqual(highestReleaseVersion(names), { version: "0.2.7" });
  });
  it("returns version null when no release tag exists (fresh repo: only the plugin.json arm remains)", () => {
    assert.deepEqual(highestReleaseVersion(["main", "v1.2.3-rc1"]), { version: null });
    assert.deepEqual(highestReleaseVersion([]), { version: null });
  });
});

describe("applyEntryBump", () => {
  it("bumps version and source.ref together, changing exactly two lines and nothing else", () => {
    const before = manifestText("0.2.7");
    const result = applyEntryBump(before, { to: "0.2.8" });
    assert.ok(!result.error, result.error ?? "");
    const afterLines = result.text.split("\n");
    assert.equal(afterLines.length, before.split("\n").length, "no lines added or removed");
    const changed = before.split("\n").filter((line, i) => line !== afterLines[i]);
    assert.equal(changed.length, 2, `exactly the version and ref lines change, got ${changed.length}: ${changed.join(" | ")}`);
    const after = JSON.parse(result.text);
    const entry = after.plugins.find((p) => p.name === "z-pr-review");
    assert.equal(entry.version, "0.2.8");
    assert.equal(entry.source.ref, "v0.2.8");
    // The sibling entry survives untouched (never stomp siblings).
    const siblingBefore = JSON.parse(before).plugins.find((p) => p.name === "gem-pr-review");
    assert.deepEqual(after.plugins.find((p) => p.name === "gem-pr-review"), siblingBefore);
  });
  it("fails closed when the entry is missing", () => {
    const text = `${JSON.stringify({ name: "xpepper-copilot-plugins", plugins: [{ name: "gem-pr-review" }] }, null, 2)}\n`;
    assert.match(applyEntryBump(text, { to: "0.2.8" }).error, /no z-pr-review entry/);
  });
  it("fails closed when a same-named entry points at another repository (never touch a stranger's entry)", () => {
    const manifest = JSON.parse(manifestText("0.2.7"));
    manifest.plugins[0].source.repo = "someone/else";
    const result = applyEntryBump(`${JSON.stringify(manifest, null, 2)}\n`, { to: "0.2.8" });
    assert.match(result.error, /someone\/else/);
  });
  it("fails closed on a non-strict target version (nothing is written unvalidated)", () => {
    for (const bad of ["0.2.8-rc1", "v0.2.8", "latest", "01.2.3"]) {
      assert.match(applyEntryBump(manifestText("0.2.7"), { to: bad }).error, /not strict X\.Y\.Z/);
    }
  });
  it("fails closed on unparseable JSON", () => {
    assert.match(applyEntryBump("{oops", { to: "0.2.8" }).error, /not parseable JSON/);
  });
  it("fails closed when the file is not the canonical 2-space JSON shape (refuses a whole-file rewrite)", () => {
    const manifest = JSON.parse(manifestText("0.2.7"));
    const result = applyEntryBump(`${JSON.stringify(manifest, null, 4)}\n`, { to: "0.2.8" });
    assert.match(result.error, /formatting/);
    assert.match(result.error, /by hand/);
  });
});

// bumpMarketplaceEntry: the loop's post-merge step. The fake gh api answers the
// contents API (GET returns {sha, content: base64}; PUT takes message/content/
// sha) and git ls-remote answers the tag-existence check.
describe("bumpMarketplaceEntry", () => {
  const res = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr });
  const TAG_OID = "1".repeat(40);
  const contents = (text, sha) => res(JSON.stringify({ name: "marketplace.json", sha, content: Buffer.from(text, "utf8").toString("base64"), encoding: "base64" }));
  const decodedPutContent = (args) => {
    const field = args.find((a) => typeof a === "string" && a.startsWith("content="));
    assert.ok(field, "the PUT must carry a content= field");
    return Buffer.from(field.slice("content=".length), "base64").toString("utf8");
  };
  const fake = ({ live = manifestText("0.2.7"), sha = "S1", putResults = [res()], tagResult = res(`${TAG_OID}\trefs/tags/v0.2.8\n`), verifyLive = null } = {}) => {
    const calls = [];
    let put = 0;
    let get = 0;
    const run = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "git" && args[0] === "ls-remote") return tagResult;
      if (command === "gh" && args[0] === "api" && args[1] === "-X" && args[2] === "PUT") {
        const result = putResults[Math.min(put, putResults.length - 1)];
        put += 1;
        return result;
      }
      if (command === "gh" && args[0] === "api") {
        get += 1;
        // First GET returns the pre-bump manifest; later GETs (retry re-fetch,
        // post-bump verification) return verifyLive when provided.
        if (get === 1) return contents(live, sha);
        return contents(verifyLive ?? live, get === 2 ? "S2" : "S3");
      }
      return res();
    };
    return { calls, run };
  };
  const ghCalls = (calls) => calls.filter(([command]) => command === "gh");
  const putCalls = (calls) => calls.filter(([command, arg0, arg1]) => command === "gh" && arg0 === "api" && arg1 === "-X");

  it("confirms the release tag exists on origin, bumps entry version+ref together via the contents API, then verifies", async () => {
    const after = manifestText("0.2.8");
    const { calls, run } = fake({ verifyLive: after });
    const result = await bumpMarketplaceEntry({ run, repoRoot: "/tmp/any", version: "0.2.8" });
    assert.ok(result.ok, result.detail ?? "");
    assert.match(result.detail, /entry bumped to 0\.2\.8/);
    assert.ok(calls.some(([command, ...args]) => command === "git" && args.join(" ").includes("ls-remote --tags origin refs/tags/v0.2.8")),
      "the pinned tag's existence on origin is checked (fail loudly with the tag name if not)");
    assert.equal(putCalls(calls).length, 1, "exactly one PUT commit");
    const put = putCalls(calls)[0];
    assert.ok(put.join(" ").includes("message=z-pr-review 0.2.8"), "a one-line, conventional commit message");
    assert.ok(put.join(" ").includes("sha=S1"), "the PUT carries the sha just read — optimistic concurrency, never a blind overwrite");
    // The committed content is the surgical two-line bump of the live manifest.
    const putBody = decodedPutContent(put.slice(1));
    assert.equal(JSON.parse(putBody).plugins.find((p) => p.name === "z-pr-review").source.ref, "v0.2.8");
    assert.equal(JSON.parse(putBody).plugins.find((p) => p.name === "gem-pr-review").version, "0.4.0", "the sibling entry is carried through untouched");
    assert.equal(ghCalls(calls).length, 3, "GET → PUT → verify GET");
  });

  it("fails loudly naming the tag when it does not exist on origin, and never touches the marketplace", async () => {
    const { calls, run } = fake({ tagResult: res("") });
    const result = await bumpMarketplaceEntry({ run, repoRoot: "/tmp/any", version: "0.2.8" });
    assert.equal(result.ok, false);
    assert.match(result.detail, /v0\.2\.8/);
    assert.match(result.detail, /does not exist on origin/);
    assert.equal(ghCalls(calls).length, 0, "no marketplace read or write may happen before the tag check");
  });

  it("fails closed when the tag existence check itself fails", async () => {
    const { run } = fake({ tagResult: res("", 128, "fatal: could not read from remote repository") });
    const result = await bumpMarketplaceEntry({ run, repoRoot: "/tmp/any", version: "0.2.8" });
    assert.equal(result.ok, false);
    assert.match(result.detail, /ls-remote failed/);
  });

  it("is idempotent: an entry already at the released version/ref needs no commit", async () => {
    const { calls, run } = fake({ live: manifestText("0.2.8") });
    const result = await bumpMarketplaceEntry({ run, repoRoot: "/tmp/any", version: "0.2.8" });
    assert.ok(result.ok, result.detail ?? "");
    assert.match(result.detail, /already at 0\.2\.8/);
    assert.equal(putCalls(calls).length, 0, "a retried post-merge step must not re-commit");
  });

  it("re-fetches and retries once on PUT rejection, re-applying onto the FRESH manifest (pull --rebase equivalent, never stomp, never force)", async () => {
    // Between the first GET and the rejected PUT, the sibling's entry moved
    // (0.4.0 → 0.4.1) — the retry must carry that change through.
    const afterSiblingMoved = manifestText("0.2.7", "0.4.1");
    const afterBoth = manifestText("0.2.8", "0.4.1");
    const calls = [];
    let put = 0;
    let get = 0;
    const run = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "git" && args[0] === "ls-remote") return res(`${TAG_OID}\trefs/tags/v0.2.8\n`);
      if (command === "gh" && args[0] === "api" && args[1] === "-X" && args[2] === "PUT") {
        put += 1;
        return put === 1 ? res("", 1, "409 Conflict: is at once") : res();
      }
      if (command === "gh" && args[0] === "api") {
        get += 1;
        if (get === 1) return contents(manifestText("0.2.7"), "S1");
        if (get === 2) return contents(afterSiblingMoved, "S2");
        return contents(afterBoth, "S3");
      }
      return res();
    };
    const result = await bumpMarketplaceEntry({ run, repoRoot: "/tmp/any", version: "0.2.8" });
    assert.ok(result.ok, result.detail ?? "");
    assert.equal(putCalls(calls).length, 2, "exactly one retry");
    assert.ok(putCalls(calls)[1].join(" ").includes("sha=S2"), "the retry PUT carries the FRESH sha (the rebase)");
    const retryBody = decodedPutContent(putCalls(calls)[1].slice(1));
    assert.equal(JSON.parse(retryBody).plugins.find((p) => p.name === "gem-pr-review").version, "0.4.1", "the sibling's concurrent change is preserved, not stomped");
    assert.match(result.detail, /retry|re-fetch|conflict/i);
  });

  it("fails closed when the PUT is rejected twice (one retry only — disclosed, never forced)", async () => {
    const { run } = fake({ putResults: [res("", 1, "409 Conflict"), res("", 1, "409 Conflict again")] });
    const result = await bumpMarketplaceEntry({ run, repoRoot: "/tmp/any", version: "0.2.8" });
    assert.equal(result.ok, false);
    assert.match(result.detail, /409 Conflict/);
    assert.match(result.detail, /retry/i);
  });

  it("fails loudly when the post-bump verification still reads the old entry", async () => {
    // verifyLive defaults to the pre-bump manifest: even a code-0 PUT is not
    // trusted without re-reading the live entry.
    const { run } = fake({});
    const result = await bumpMarketplaceEntry({ run, repoRoot: "/tmp/any", version: "0.2.8" });
    assert.equal(result.ok, false);
    assert.match(result.detail, /verification failed/);
    assert.match(result.detail, /0\.2\.7/);
  });

  it("fails closed when the live manifest cannot be read", async () => {
    const { run } = fake({});
    const wrapped = async (command, args) =>
      command === "gh" && args[0] === "api" && args[1] !== "-X"
        ? res("", 1, "gh: rate limit")
        : run(command, args);
    const result = await bumpMarketplaceEntry({ run: wrapped, repoRoot: "/tmp/any", version: "0.2.8" });
    assert.equal(result.ok, false);
    assert.match(result.detail, /cannot read the live manifest/);
    assert.match(result.detail, /rate limit/);
  });

  it("fails closed when the live manifest has no z-pr-review entry (nothing to bump, nothing invented)", async () => {
    const noEntry = `${JSON.stringify({ name: "xpepper-copilot-plugins", plugins: [{ name: "gem-pr-review", version: "0.4.0", source: { repo: "xpepper/pr-review-gemini", path: ".", ref: "v0.4.0" } }] }, null, 2)}\n`;
    const { calls, run } = fake({ live: noEntry });
    const result = await bumpMarketplaceEntry({ run, repoRoot: "/tmp/any", version: "0.2.8" });
    assert.equal(result.ok, false);
    assert.match(result.detail, /no z-pr-review entry/);
    assert.equal(putCalls(calls).length, 0, "no commit is attempted");
  });
});

// The merge path in scripts/dev-loop.mjs stops fail-loudly when the post-merge
// version read fails, interpolating the version result's reason into its
// stderr. Both error paths that build the result — parseVersion's error return
// and the read-failure catch in dev-loop.mjs — carry the reason on `.error`;
// an earlier draft interpolated `.detail`, undefined on both paths, so the
// stop reason read "…): undefined" and lost the actual cause (review finding).
// This pins the shape the interpolation relies on.
describe("post-merge version read fail-loud reason", () => {
  it("carries the reason on .error — the field the merge path interpolates — never .detail (which renders undefined)", () => {
    for (const text of ["{oops", "{}"]) {
      const released = parseVersion(text, "plugin.json (main)");
      assert.match(released.error, /plugin\.json \(main\)/, "the failure mode under test must fire");
      assert.equal(released.detail, undefined, "the reason lives on .error; interpolating .detail renders 'undefined'");
    }
    // The composed stop reason carries the actual parse failure — interpolating
    // the wrong field would end the message with the literal "undefined"
    // instead. (The missing-version reason text above legitimately contains
    // "undefined" as the reported value, so this uses the unparseable case.)
    const released = parseVersion("{oops", "plugin.json (main)");
    const stderr = `cannot read the released version to publish to the marketplace (merge and release tag v0.2.8 completed): ${released.error}`;
    assert.match(stderr, /is not parseable JSON/);
    assert.doesNotMatch(stderr, /undefined/, "the fail-loud output must carry the actual reason, never an undefined field");
  });
});
