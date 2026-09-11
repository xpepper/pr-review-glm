// tests/plugin-version.test.mjs — readPluginVersion (the status Version line's
// only source): the real plugin.json, plus temp-manifest degradation cases.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readPluginVersion } from "../extensions/z-pr-review/version.mjs";

const withManifest = (text, fn) => async () => {
  const dir = mkdtempSync(join(tmpdir(), "zpr-pluginver-"));
  try {
    const path = join(dir, "plugin.json");
    if (text !== null) writeFileSync(path, text);
    await fn(pathToFileURL(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("readPluginVersion", () => {
  it("reads the running version from the repo's real plugin.json", () => {
    const version = readPluginVersion();
    assert.match(version, /^\d+\.\d+\.\d+$/, `expected a strict X.Y.Z version, got ${version}`);
  });
  it("returns the version field of the manifest it is given", withManifest(`{"version": "0.2.0"}\n`, async (url) => {
    assert.equal(readPluginVersion(url), "0.2.0");
  }));
  it("degrades to null on a missing manifest", withManifest(null, async (url) => {
    assert.equal(readPluginVersion(url), null);
  }));
  it("degrades to null on unparseable JSON", withManifest("{oops", async (url) => {
    assert.equal(readPluginVersion(url), null);
  }));
  it("degrades to null when the version field is absent or non-string", withManifest(`{"name": "z-pr-review"}\n`, async (url) => {
    assert.equal(readPluginVersion(url), null);
  }));
  it("degrades to null on a non-string version", withManifest(`{"version": 3}\n`, async (url) => {
    assert.equal(readPluginVersion(url), null);
  }));
});
