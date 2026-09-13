// Unit tests for the M1 marketplace-consistency rules (tests/smoke-m1.mjs).
// The network fetch itself is exercised by the smoke; these cover the
// rule matrix, including the release-discipline failure messages.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkMarketplaceConsistency, fetchMarketplaceManifest } from "./smoke-m1.mjs";

const entry = (overrides = {}, sourceOverrides = {}) => ({
  name: "z-pr-review",
  version: "0.2.5",
  source: { source: "github", repo: "xpepper/pr-review-glm", path: ".", ref: "v0.2.5", ...sourceOverrides },
  ...overrides,
});

const manifestWith = (plugins) => ({ name: "xpepper-copilot-plugins", plugins });

describe("checkMarketplaceConsistency", () => {
  it("passes on the consistent entry shape", () => {
    const { problems } = checkMarketplaceConsistency({
      manifest: manifestWith([entry()]),
      pluginVersion: "0.2.5",
    });
    assert.deepEqual(problems, []);
  });

  it("fails naming the marketplace repo when the entry is missing", () => {
    const { problems } = checkMarketplaceConsistency({
      manifest: manifestWith([{ name: "some-other-plugin" }]),
      pluginVersion: "0.2.5",
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /xpepper\/copilot-plugins.*no z-pr-review entry/);
  });

  it("fails when the manifest has no plugins array", () => {
    const { problems } = checkMarketplaceConsistency({ manifest: { name: "xpepper-copilot-plugins" }, pluginVersion: "0.2.5" });
    assert.match(problems[0], /xpepper\/copilot-plugins.*no plugins\[\] array/);
  });

  it("fails when the entry points at a different repository", () => {
    const { problems } = checkMarketplaceConsistency({
      manifest: manifestWith([entry({}, { repo: "someone/else" })]),
      pluginVersion: "0.2.5",
    });
    assert.match(problems[0], /must point at xpepper\/pr-review-glm, found someone\/else/);
  });

  it("fails when the entry no longer installs from the repo root", () => {
    const { problems } = checkMarketplaceConsistency({
      manifest: manifestWith([entry({}, { path: "plugins/z-pr-review" })]),
      pluginVersion: "0.2.5",
    });
    assert.match(problems[0], /repo root \(path "\."\)/);
  });

  it("fails with the release-discipline remedy on a version mismatch", () => {
    const { problems } = checkMarketplaceConsistency({
      manifest: manifestWith([entry({ version: "0.2.4" }, { ref: "v0.2.4" })]),
      pluginVersion: "0.2.5",
    });
    const versionProblem = problems.find((p) => p.includes("version"));
    assert.ok(versionProblem, `expected a version problem, got: ${problems.join(" | ")}`);
    assert.match(versionProblem, /0\.2\.4 != plugin\.json 0\.2\.5/);
    assert.match(versionProblem, /bump the entry/);
    assert.match(versionProblem, /xpepper\/copilot-plugins/);
  });

  it("fails when the ref tag does not match the plugin version", () => {
    const { problems } = checkMarketplaceConsistency({
      manifest: manifestWith([entry({}, { ref: "main" })]),
      pluginVersion: "0.2.5",
    });
    assert.match(problems[0], /must pin source\.ref to v0\.2\.5, found "main"/);
  });

  it("reports every problem at once", () => {
    const { problems } = checkMarketplaceConsistency({
      manifest: manifestWith([entry({ version: "0.2.4" }, { repo: "someone/else", ref: "v0.2.4" })]),
      pluginVersion: "0.2.5",
    });
    assert.equal(problems.length, 3);
  });

  it("fails when the entry does not use the github source form", () => {
    const { problems } = checkMarketplaceConsistency({
      manifest: manifestWith([entry({}, { source: "git", repo: "xpepper/pr-review-glm" })]),
      pluginVersion: "0.2.5",
    });
    assert.match(problems[0], /must use the github source form, found "git"/);
  });
});

describe("fetchMarketplaceManifest token handling", () => {
  const stubFetch = (capture) => async (url, init) => {
    capture.url = url;
    capture.headers = init.headers;
    return { ok: true, json: async () => ({ plugins: [] }) };
  };
  const realFetch = globalThis.fetch;

  it("sends GH_TOKEN only to the api.github.com host", async () => {
    process.env.GH_TOKEN = "tok";
    try {
      const toGithub = {};
      globalThis.fetch = stubFetch(toGithub);
      await fetchMarketplaceManifest();
      assert.equal(toGithub.headers.Authorization, "Bearer tok");

      const toElsewhere = {};
      globalThis.fetch = stubFetch(toElsewhere);
      await fetchMarketplaceManifest("https://evil.example.com/manifest.json");
      assert.equal(toElsewhere.headers.Authorization, undefined, "token must not leak to an overridden URL host");
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
      assert.equal(capture.headers.Authorization, undefined);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
