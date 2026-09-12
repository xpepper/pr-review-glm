import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_EFFORTS,
  REVIEW_MODES,
  defaultConfig,
  validateConfig,
} from "../extensions/z-pr-review/config.mjs";

describe("defaultConfig", () => {
  it("returns the spec's default configuration", () => {
    assert.deepEqual(defaultConfig(), {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      tiers: {
        light: { model: null, effort: "low" },
        medium: { model: null, effort: "medium" },
        heavy: { model: null, effort: "high" },
      },
      defaultMode: "balanced",
      roles: {},
      modes: {},
      autoPostReviews: false,
      deadlines: {
        attemptMs: { light: 180_000, medium: 360_000, heavy: 720_000 },
        fallbackMs: 180_000,
        batchMs: 720_000,
        adjudicationMs: 60_000,
        totalMs: 900_000,
      },
    });
  });

  it("returns a fresh copy each call", () => {
    const a = defaultConfig();
    a.tiers.heavy.model = "mutated";
    assert.equal(defaultConfig().tiers.heavy.model, null);
  });
});

describe("validateConfig", () => {
  const valid = () => defaultConfig();

  it("accepts the default configuration", () => {
    assert.deepEqual(validateConfig(valid()), { valid: true });
  });

  it("accepts explicit tier models and fallbacks", () => {
    const config = valid();
    config.tiers.heavy = { model: "gpt-5.6-terra", effort: "high", fallback: "gpt-5.4" };
    config.tiers.light.model = "gpt-5.4";
    assert.deepEqual(validateConfig(config), { valid: true });
  });

  it("reports every problem instead of stopping at the first", () => {
    const config = valid();
    config.defaultMode = "turbo";
    config.autoPostReviews = "yes";
    const result = validateConfig(config);
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 2);
  });

  it("rejects a missing top-level key (partial config)", () => {
    const config = valid();
    delete config.deadlines;
    const result = validateConfig(config);
    assert.equal(result.valid, false);
    assert(result.errors.some((e) => e.includes("deadlines")));
  });

  it("rejects an unknown top-level key", () => {
    const config = valid();
    config.extra = true;
    const result = validateConfig(config);
    assert.equal(result.valid, false);
    assert(result.errors.some((e) => e.includes("extra")));
  });

  it("rejects a wrong schema version", () => {
    const config = valid();
    config.schemaVersion = 3;
    const result = validateConfig(config);
    assert.equal(result.valid, false);
    assert(result.errors.some((e) => e.includes("schemaVersion")));
  });

  it("rejects a missing or extra tier", () => {
    const missing = valid();
    delete missing.tiers.medium;
    const extra = valid();
    extra.tiers.extreme = { model: null, effort: "max" };
    for (const config of [missing, extra]) {
      const result = validateConfig(config);
      assert.equal(result.valid, false);
      assert(result.errors.some((e) => e.includes("tiers")));
    }
  });

  it("rejects an unknown tier field, bad effort, and non-string/non-null model", () => {
    const unknownField = valid();
    unknownField.tiers.heavy.temperature = 0.2;
    const badEffort = valid();
    badEffort.tiers.light.effort = "extreme";
    const badModel = valid();
    badModel.tiers.medium.model = 42;
    for (const config of [unknownField, badEffort, badModel]) {
      const result = validateConfig(config);
      assert.equal(result.valid, false);
    }
    assert(validateConfig(unknownField).errors.some((e) => e.includes("temperature")));
    assert(validateConfig(badEffort).errors.some((e) => e.includes("effort")));
    assert(validateConfig(badModel).errors.some((e) => e.includes("model")));
  });

  it("rejects an empty-string or non-string fallback", () => {
    const empty = valid();
    empty.tiers.heavy.fallback = "";
    const numeric = valid();
    numeric.tiers.heavy.fallback = 7;
    for (const config of [empty, numeric]) {
      const result = validateConfig(config);
      assert.equal(result.valid, false);
      assert(result.errors.some((e) => e.includes("fallback")));
    }
  });

  it("rejects a fallback equal to the tier's own model", () => {
    const config = valid();
    config.tiers.heavy.model = "gpt-5.6-terra";
    config.tiers.heavy.fallback = "gpt-5.6-terra";
    const result = validateConfig(config);
    assert.equal(result.valid, false);
    assert(result.errors.some((e) => e.includes("fallback")));
  });

  it("rejects an unknown review mode", () => {
    const config = valid();
    config.defaultMode = "thorough";
    const result = validateConfig(config);
    assert.equal(result.valid, false);
    assert(result.errors.some((e) => e.includes("defaultMode")));
  });

  it("rejects a non-boolean autoPostReviews", () => {
    const config = valid();
    config.autoPostReviews = 1;
    const result = validateConfig(config);
    assert.equal(result.valid, false);
    assert(result.errors.some((e) => e.includes("autoPostReviews")));
  });

  it("rejects non-positive-integer deadline values", () => {
    for (const bad of [0, -5, 1.5, "60000"]) {
      const config = valid();
      config.deadlines.batchMs = bad;
      const result = validateConfig(config);
      assert.equal(result.valid, false, `batchMs=${String(bad)} must be rejected`);
      assert(result.errors.some((e) => e.includes("batchMs")));
    }
  });

  it("rejects a missing or unknown deadline key", () => {
    const missing = valid();
    delete missing.deadlines.adjudicationMs;
    const unknown = valid();
    unknown.deadlines.graceMs = 1000;
    for (const config of [missing, unknown]) {
      const result = validateConfig(config);
      assert.equal(result.valid, false);
    }
    assert(validateConfig(missing).errors.some((e) => e.includes("adjudicationMs")));
    assert(validateConfig(unknown).errors.some((e) => e.includes("graceMs")));
  });

  it("rejects deadlines where the total does not exceed batch, attempts, and adjudication", () => {
    const totalNotOverBatch = valid();
    totalNotOverBatch.deadlines.totalMs = totalNotOverBatch.deadlines.batchMs;
    const totalNotOverAttempt = valid();
    totalNotOverAttempt.deadlines.totalMs = 700_000; // heavy attempt is 720000
    const totalNotOverAdjudication = valid();
    totalNotOverAdjudication.deadlines.totalMs = 30_000; // adjudication is 60000
    for (const config of [totalNotOverBatch, totalNotOverAttempt, totalNotOverAdjudication]) {
      const result = validateConfig(config);
      assert.equal(result.valid, false);
      assert(result.errors.some((e) => e.includes("totalMs")), JSON.stringify(result.errors));
    }
  });

  it("exposes the effort and mode enums it validates against", () => {
    assert.deepEqual(REVIEW_MODES, ["quick", "balanced", "full", "deep"]);
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      assert(DEFAULT_EFFORTS.includes(effort), `${effort} must be a valid effort`);
    }
  });
});

// --- C1: roles and modes -----------------------------------------------------

describe("validateConfig roles/modes (C1)", () => {
  const valid = () => defaultConfig();

  it("accepts a well-formed role and a custom mode composing it with built-ins", () => {
    const config = valid();
    config.roles = {
      "api-hygiene": { prompt: "API design and hygiene across the diff.", tier: "medium" },
    };
    config.modes = { "hygiene-first": ["overview", "api-hygiene", "correctness"] };
    assert.deepEqual(validateConfig(config), { valid: true });
  });

  it("accepts role model/effort overrides (null model = session model)", () => {
    const config = valid();
    config.roles = {
      "fast-pass": { prompt: "Quick pass.", tier: "light", model: null, effort: "minimal" },
    };
    assert.deepEqual(validateConfig(config), { valid: true });
  });

  it("rejects roles that are missing prompt/tier or carry unknown keys", () => {
    const missingPrompt = valid();
    missingPrompt.roles = { bad: { tier: "heavy" } };
    const missingTier = valid();
    missingTier.roles = { bad: { prompt: "p" } };
    const unknownKey = valid();
    unknownKey.roles = { bad: { prompt: "p", tier: "heavy", temperature: 0.2 } };
    for (const config of [missingPrompt, missingTier, unknownKey]) {
      const result = validateConfig(config);
      assert.equal(result.valid, false);
    }
    assert(validateConfig(missingPrompt).errors.some((e) => e.startsWith("roles.bad:") && e.includes("prompt")));
    assert(validateConfig(missingTier).errors.some((e) => e.startsWith("roles.bad:") && e.includes("tier")));
    assert(validateConfig(unknownKey).errors.some((e) => e.includes("temperature")));
  });

  it("rejects an empty prompt, unknown tier, bad effort, and non-string/non-null model", () => {
    for (const [mutation, needle] of [
      [(role) => (role.prompt = "  "), "prompt"],
      [(role) => (role.tier = "extreme"), "tier"],
      [(role) => (role.effort = "ludicrous"), "effort"],
      [(role) => (role.model = 42), "model"],
    ]) {
      const config = valid();
      const role = { prompt: "p", tier: "heavy" };
      mutation(role);
      config.roles = { bad: role };
      const result = validateConfig(config);
      assert.equal(result.valid, false);
      assert(result.errors.some((e) => e.includes(`roles.bad.${needle}`)), JSON.stringify(result.errors));
    }
  });

  it("rejects a role id colliding with a built-in lane id", () => {
    const config = valid();
    config.roles = { correctness: { prompt: "p", tier: "heavy" } };
    const result = validateConfig(config);
    assert.equal(result.valid, false);
    assert(result.errors.some((e) => e.includes("collides with built-in lane id")));
  });

  it("rejects modes referencing unknown lane ids and non-array/empty shapes", () => {
    const unknownId = valid();
    unknownId.modes = { custom: ["overview", "nope"] };
    const notArray = valid();
    notArray.modes = { custom: "overview" };
    const empty = valid();
    empty.modes = { custom: [] };
    for (const config of [unknownId, notArray, empty]) {
      const result = validateConfig(config);
      assert.equal(result.valid, false);
    }
    assert(validateConfig(unknownId).errors.some((e) => e.includes("nope")));
    assert(validateConfig(notArray).errors.some((e) => e.includes("modes.custom")));
    assert(validateConfig(empty).errors.some((e) => e.includes("modes.custom")));
  });

  it("rejects a mode referencing a role that is not defined (roles and modes cross-check)", () => {
    const config = valid();
    config.roles = {};
    config.modes = { custom: ["ghost-role"] };
    const result = validateConfig(config);
    assert.equal(result.valid, false);
    assert(result.errors.some((e) => e.includes("ghost-role")));
  });

  it("allows overriding a standard mode name and selecting it (or a custom mode) as defaultMode", () => {
    const config = valid();
    config.roles = { extra: { prompt: "p", tier: "light" } };
    config.modes = { balanced: ["overview", "extra"], turbo: ["extra", "correctness"] };
    config.defaultMode = "turbo";
    assert.deepEqual(validateConfig(config), { valid: true });
  });

  it("rejects defaultMode values that are neither standard nor config-defined modes", () => {
    const config = valid();
    config.modes = { turbo: ["overview"] };
    config.defaultMode = "thorough";
    const result = validateConfig(config);
    assert.equal(result.valid, false);
    assert(result.errors.some((e) => e.includes("defaultMode")));
  });
});

// --- ConfigStore -----------------------------------------------------------

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, ConfigStore } from "../extensions/z-pr-review/config.mjs";

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), "z-pr-review-test-"));
  return { store: new ConfigStore(join(dir, "nested", "config.json")), dir };
}

describe("ConfigStore.load", () => {
  it("returns defaults without creating anything when no file exists", async () => {
    const { store, dir } = newStore();
    const state = await store.load();
    assert.equal(state.source, "defaults");
    assert.deepEqual(state.config, defaultConfig());
    assert.deepEqual(state.warnings, []);
    assert.equal(readdirSync(dir).length, 0, "load must not create files");
  });

  it("reads a valid file as the source of truth", async () => {
    const { store } = newStore();
    await store.set([["tiers.heavy.model", "gpt-5.6-terra"]]);
    const fresh = new ConfigStore(store.path);
    const state = await fresh.load();
    assert.equal(state.source, "file");
    assert.equal(state.config.tiers.heavy.model, "gpt-5.6-terra");
    assert.deepEqual(state.warnings, []);
  });

  it("rejects malformed JSON, keeps the file, and activates defaults", async () => {
    const { store } = newStore();
    mkdirSync(join(store.path, ".."), { recursive: true });
    writeFileSync(store.path, "{ not json", { mode: 0o600 });
    const state = await store.load();
    assert.equal(state.source, "defaults");
    assert.deepEqual(state.config, defaultConfig());
    assert.equal(state.warnings.length, 1);
    assert(state.warnings[0].includes(store.path));
    assert.equal(readFileSync(store.path, "utf8"), "{ not json");
  });

  it("rejects a partial or wrong-schema file as a unit", async () => {
    for (const bad of [
      { schemaVersion: 1, tiers: defaultConfig().tiers },
      { ...defaultConfig(), schemaVersion: 99 },
    ]) {
      const { store } = newStore();
      mkdirSync(join(store.path, ".."), { recursive: true });
      writeFileSync(store.path, JSON.stringify(bad), { mode: 0o600 });
      const state = await store.load();
      assert.equal(state.source, "defaults");
      assert.equal(state.warnings.length, 1);
    }
  });
});

describe("ConfigStore.set", () => {
  it("persists the change with 0600 file and 0700 directory modes", async () => {
    const { store } = newStore();
    await store.set([["defaultMode", "full"]]);
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(store.path, "..")).mode & 0o777, 0o700);
    const onDisk = JSON.parse(readFileSync(store.path, "utf8"));
    assert.equal(onDisk.defaultMode, "full");
    assert.equal(onDisk.schemaVersion, CONFIG_SCHEMA_VERSION);
    assert.deepEqual(readdirSync(join(store.path, "..")), ["config.json"], "no temp files linger");
  });

  it("coerces true/false and integers, keeps other values as strings", async () => {
    const { store } = newStore();
    await store.set([
      ["autoPostReviews", "true"],
      ["deadlines.batchMs", "300000"],
      ["tiers.light.effort", "minimal"],
    ]);
    const config = store.get();
    assert.equal(config.autoPostReviews, true);
    assert.equal(config.deadlines.batchMs, 300_000);
    assert.equal(config.tiers.light.effort, "minimal");
  });

  it("rejects an invalid value without touching the file or memory", async () => {
    const { store } = newStore();
    await store.set([["defaultMode", "full"]]);
    const before = readFileSync(store.path, "utf8");
    await assert.rejects(() => store.set([["defaultMode", "turbo"]]), ConfigError);
    assert.equal(readFileSync(store.path, "utf8"), before);
    assert.equal(store.get().defaultMode, "full");
  });

  it("applies multiple entries atomically: one bad entry rejects the whole set", async () => {
    const { store } = newStore();
    await assert.rejects(
      () => store.set([["tiers.light.effort", "low"], ["defaultMode", "turbo"]]),
      ConfigError,
    );
    assert.deepEqual(store.get(), defaultConfig(), "memory keeps the last valid state");
    assert.equal(await exists(store.path), false);
  });

  it("rejects unknown, non-leaf, and reserved paths with a clear error", async () => {
    const { store } = newStore();
    for (const path of ["tiers.ultra.model", "tiers", "tiers.heavy", "schemaVersion", "deadlines.attemptMs", ""]) {
      await assert.rejects(() => store.set([[path, "x"]]), (error) => {
        assert(error instanceof ConfigError);
        assert(error.problems.some((p) => p.includes(path)));
        return true;
      }, `path ${path} must be rejected`);
    }
  });

  it("rejects an empty or whitespace-only value", async () => {
    const { store } = newStore();
    await assert.rejects(() => store.set([["tiers.heavy.model", ""]]), ConfigError);
    await assert.rejects(() => store.set([["tiers.heavy.model", "   "]]), ConfigError);
  });
});

describe("ConfigStore.unset", () => {
  it("restores default values and removes optional keys", async () => {
    const { store } = newStore();
    await store.set([
      ["defaultMode", "deep"],
      ["tiers.heavy.model", "gpt-5.6-terra"],
      ["tiers.heavy.fallback", "gpt-5.4"],
    ]);
    await store.unset(["defaultMode", "tiers.heavy.model", "tiers.heavy.fallback"]);
    const config = store.get();
    assert.equal(config.defaultMode, "balanced");
    assert.equal(config.tiers.heavy.model, null);
    assert.equal("fallback" in config.tiers.heavy, false);
    const onDisk = JSON.parse(readFileSync(store.path, "utf8"));
    assert.equal(onDisk.tiers.heavy.fallback, undefined);
  });

  it("rejects unknown paths", async () => {
    const { store } = newStore();
    await assert.rejects(() => store.unset(["tiers.ultra.model", "nope"]), ConfigError);
  });
});

async function exists(path) {
  const { stat } = await import("node:fs/promises");
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("ConfigStore with a rejected file", () => {
  it("refuses to set or unset while the on-disk file is rejected, leaving it untouched", async () => {
    const { store } = newStore();
    mkdirSync(join(store.path, ".."), { recursive: true });
    writeFileSync(store.path, "{ not json", { mode: 0o600 });
    await store.load();
    await assert.rejects(() => store.set([["defaultMode", "full"]]), ConfigError);
    await assert.rejects(() => store.unset(["defaultMode"]), ConfigError);
    assert.equal(readFileSync(store.path, "utf8"), "{ not json");
  });

  it("allows writes again once the file is fixed and reloaded", async () => {
    const { store } = newStore();
    mkdirSync(join(store.path, ".."), { recursive: true });
    writeFileSync(store.path, "{ not json", { mode: 0o600 });
    await store.load();
    writeFileSync(store.path, JSON.stringify(defaultConfig()), { mode: 0o600 });
    await store.load();
    await store.set([["defaultMode", "full"]]);
    assert.equal(JSON.parse(readFileSync(store.path, "utf8")).defaultMode, "full");
  });
});

describe("ConfigStore.set value hygiene", () => {
  it("rejects values containing control characters", async () => {
    const { store } = newStore();
    await assert.rejects(() => store.set([["tiers.heavy.model", "bad\u0007model"]]), ConfigError);
  });
});
