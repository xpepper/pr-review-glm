// Unit tests for the M1 marketplace-consistency rules (tests/smoke-m1.mjs,
// pure logic in scripts/dev-loop/marketplace.mjs). The network fetch itself is
// exercised by the smoke; these cover the rule matrix, including the R45
// either-or release-discipline acceptance and failure messages.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkMarketplaceConsistency, fetchLatestReleaseVersion, fetchMarketplaceManifest } from "./smoke-m1.mjs";

const entry = (overrides = {}, sourceOverrides = {}) => ({
  name: "z-pr-review",
  version: "0.2.7",
  source: { source: "github", repo: "xpepper/pr-review-glm", path: ".", ref: "v0.2.7", ...sourceOverrides },
  ...overrides,
});

const manifestWith = (plugins) => ({ name: "xpepper-copilot-plugins", plugins });

describe("checkMarketplaceConsistency", () => {
  it("passes on the consistent entry shape", () => {
    const { problems } = checkMarketplaceConsistency({
      manifest: manifestWith([entry()]),
      pluginVersion: "0.2.7",
      lastReleasedVersion: "0.2.7",
    });
    assert.deepEqual(problems, []);
  });

  it("fails naming the marketplace repo when the entry is missing", () => {
    const { problems } = checkMarketplaceConsistency({
      manifest: manifestWith([{ name: "some-other-plugin" }]),
      pluginVersion: "0.2.7",
      lastReleasedVersion: "0.2.6",
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /xpepper\/copilot-plugins.*no z-pr-review entry/);
  });

  it("fails when the manifest has no plugins array", () => {
    const { problems } = checkMarketplaceConsistency({ manifest: { name: "xpepper-copilot-plugins" }, pluginVersion: "0.2.7", lastReleasedVersion: "0.2.6" });
    assert.match(problems[0], /xpepper\/copilot-plugins.*no plugins\[\] array/);
  });

  it("fails when the entry points at a different repository", () => {
    const { problems } = checkMarketplaceConsistency({
      manifest: manifestWith([entry({}, { repo: "someone/else" })]),
      pluginVersion: "0.2.7",
      lastReleasedVersion: "0.2.6",
    });
    assert.match(problems[0], /must point at xpepper\/pr-review-glm, found someone\/else/);
  });

  it("fails when the entry no longer installs from the repo root", () => {
    const { problems } = checkMarketplaceConsistency({
      manifest: manifestWith([entry({}, { path: "plugins/z-pr-review" })]),
      pluginVersion: "0.2.7",
      lastReleasedVersion: "0.2.6",
    });
    assert.match(problems[0], /repo root \(path "\."\)/);
  });

  it("fails when the entry does not use the github source form", () => {
    const { problems } = checkMarketplaceConsistency({
      manifest: manifestWith([entry({}, { source: "git", repo: "xpepper/pr-review-glm" })]),
      pluginVersion: "0.2.7",
      lastReleasedVersion: "0.2.6",
    });
    assert.match(problems[0], /must use the github source form, found "git"/);
  });

  describe("either-or release discipline (R45: the entry bump is a post-merge step)", () => {
    it("arm 1 — accepts the entry at the plugin.json version (an operator may have bumped early)", () => {
      const { problems } = checkMarketplaceConsistency({
        manifest: manifestWith([entry({ version: "0.2.8" }, { ref: "v0.2.8" })]),
        pluginVersion: "0.2.8",
        lastReleasedVersion: "0.2.7",
      });
      assert.deepEqual(problems, []);
    });

    it("arm 2 — accepts the entry still at the last released tag while the new version is in flight (no missing-tag window)", () => {
      const { problems } = checkMarketplaceConsistency({
        manifest: manifestWith([entry({ version: "0.2.7" }, { ref: "v0.2.7" })]),
        pluginVersion: "0.2.8",
        lastReleasedVersion: "0.2.7",
      });
      assert.deepEqual(problems, []);
    });

    it("fails when the entry matches NEITHER plugin.json NOR the last released tag, naming both arms", () => {
      const { problems } = checkMarketplaceConsistency({
        manifest: manifestWith([entry({ version: "0.2.5" }, { ref: "v0.2.5" })]),
        pluginVersion: "0.2.8",
        lastReleasedVersion: "0.2.7",
      });
      assert.equal(problems.length, 1);
      assert.match(problems[0], /0\.2\.5/);
      assert.match(problems[0], /plugin\.json 0\.2\.8/);
      assert.match(problems[0], /v0\.2\.7/);
      assert.match(problems[0], /xpepper\/copilot-plugins/);
    });

    it("with no release tags at all (lastReleasedVersion null), only the plugin.json arm remains", () => {
      const { problems } = checkMarketplaceConsistency({
        manifest: manifestWith([entry({ version: "0.2.5" }, { ref: "v0.2.5" })]),
        pluginVersion: "0.2.8",
        lastReleasedVersion: null,
      });
      assert.equal(problems.length, 1);
      assert.match(problems[0], /plugin\.json 0\.2\.8/);
      assert.match(problems[0], /no release tag|none/i);
    });

    it("requires source.ref to match the ENTRY's own version, whichever arm it matched", () => {
      const { problems } = checkMarketplaceConsistency({
        manifest: manifestWith([entry({ version: "0.2.7" }, { ref: "v0.2.5" })]),
        pluginVersion: "0.2.8",
        lastReleasedVersion: "0.2.7",
      });
      assert.equal(problems.length, 1);
      assert.match(problems[0], /must pin source\.ref to v0\.2\.7 \(its own version\), found "v0\.2\.5"/);
    });

    it("still refuses a branch ref", () => {
      const { problems } = checkMarketplaceConsistency({
        manifest: manifestWith([entry({}, { ref: "main" })]),
        pluginVersion: "0.2.7",
        lastReleasedVersion: "0.2.6",
      });
      assert.match(problems[0], /must pin source\.ref to v0\.2\.7 \(its own version\), found "main"/);
    });
  });

  it("reports every problem at once", () => {
    const { problems } = checkMarketplaceConsistency({
      manifest: manifestWith([entry({ version: "0.2.5" }, { repo: "someone/else", ref: "v0.2.4" })]),
      pluginVersion: "0.2.7",
      lastReleasedVersion: "0.2.6",
    });
    assert.equal(problems.length, 3, problems.join(" | "));
  });
});

describe("fetch helpers token handling", () => {
  // An array body satisfies BOTH fetchers (the manifest fetch returns
  // response.json() unchecked here; the tags fetch requires an array).
  const stubFetch = (capture, body = []) => async (url, init) => {
    capture.url = url;
    capture.headers = init.headers;
    return { ok: true, json: async () => body };
  };
  const realFetch = globalThis.fetch;

  it("sends GH_TOKEN only to the api.github.com host", async () => {
    process.env.GH_TOKEN = "tok";
    try {
      const toGithub = {};
      globalThis.fetch = stubFetch(toGithub);
      await fetchMarketplaceManifest();
      assert.equal(toGithub.headers.Authorization, "Bearer tok");
      const toGithubTags = {};
      globalThis.fetch = stubFetch(toGithubTags);
      await fetchLatestReleaseVersion();
      assert.equal(toGithubTags.headers.Authorization, "Bearer tok");

      const toElsewhere = {};
      globalThis.fetch = stubFetch(toElsewhere);
      await fetchMarketplaceManifest("https://evil.example.com/manifest.json");
      assert.equal(toElsewhere.headers.Authorization, undefined, "token must not leak to an overridden URL host");
    } finally {
      delete process.env.GH_TOKEN;
      globalThis.fetch = realFetch;
    }
  });

  it("refuses non-https URLs outright: no fetch ever runs, no token can transit plaintext, and the error names why", async () => {
    process.env.GH_TOKEN = "tok";
    let fetches = 0;
    globalThis.fetch = async () => { fetches += 1; return { ok: true, json: async () => [] }; };
    try {
      // The exact leak shape of the finding: an http:// override of the
      // api.github.com host via ZPR_TAGS_URL / ZPR_MARKETPLACE_MANIFEST_URL.
      const insecure = [
        "http://api.github.com/repos/xpepper/copilot-plugins/contents/.github/plugin/marketplace.json",
        "http://api.github.com/repos/xpepper/pr-review-glm/tags?per_page=100",
      ];
      for (const url of insecure) {
        await assert.rejects(fetchMarketplaceManifest(url), /must be reached over HTTPS.*plaintext/s);
        await assert.rejects(fetchLatestReleaseVersion(url), /must be reached over HTTPS.*plaintext/s);
      }
      assert.equal(fetches, 0, "the fetch must never run for a non-https URL — fail closed before any network hop");
    } finally {
      delete process.env.GH_TOKEN;
      globalThis.fetch = realFetch;
    }
  });

  it("never sends an Authorization header without GH_TOKEN", async () => {
    assert.equal(process.env.GH_TOKEN, undefined, "test requires a clean env");
    const capture = {};
    globalThis.fetch = stubFetch(capture);
    try {
      await fetchMarketplaceManifest();
      await fetchLatestReleaseVersion();
      assert.equal(capture.headers.Authorization, undefined);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("fetchLatestReleaseVersion derives the highest vX.Y.Z tag from the plugin repo's tag list", async () => {
    const tags = [
      { name: "v0.2.7" },
      { name: "v0.2.10" },
      { name: "not-a-release" },
    ];
    globalThis.fetch = stubFetch({}, tags);
    try {
      const { version } = await fetchLatestReleaseVersion();
      assert.equal(version, "0.2.10");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("fetchLatestReleaseVersion fails closed on HTTP and shape errors (never reports a bogus last release)", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await assert.rejects(fetchLatestReleaseVersion(), /HTTP 503/);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ oops: true }) });
    await assert.rejects(fetchLatestReleaseVersion(), /not an array/i);
    globalThis.fetch = realFetch;
  });
});
