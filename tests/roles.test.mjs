// C1: custom review roles — mode resolution, config validation interplay, and
// the per-lane model/effort override plumbing in runLane/runLaneBatch.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LANE_TOPOLOGIES } from "../extensions/z-pr-review/topologies.mjs";
import {
  builtinLaneIds,
  resolveMode,
  selectableModes,
} from "../extensions/z-pr-review/roles.mjs";
import { defaultConfig } from "../extensions/z-pr-review/config.mjs";
import { runLane } from "../extensions/z-pr-review/lane.mjs";
import { runLaneBatch } from "../extensions/z-pr-review/batch.mjs";
import { REVIEW_ENVELOPE_BEGIN, REVIEW_ENVELOPE_END } from "../extensions/z-pr-review/lane.mjs";

const ENVELOPE = {
  kind: "z-pr-review-capture",
  schemaVersion: 1,
  repo: "xpepper/pr-review-glm",
  pr: { number: 27, title: "C1", base: { refName: "main" }, head: { refName: "c1-roles" } },
  diff: "+ one line",
};

const laneConfig = {
  tiers: { light: { model: null, effort: "low" }, medium: { model: null, effort: "medium" }, heavy: { model: null, effort: "high" } },
  deadlines: {
    attemptMs: { light: 60_000, medium: 60_000, heavy: 60_000 },
    fallbackMs: 60_000,
    batchMs: 120_000,
    totalMs: 180_000,
  },
};

function validLaneText(findings = []) {
  return `${REVIEW_ENVELOPE_BEGIN}\n${JSON.stringify(findings)}\n${REVIEW_ENVELOPE_END}`;
}

// Same fake-runtime shape as tests/lane.test.mjs, with per-attempt captures.
function fakeRuntime(scripts) {
  const attempts = [];
  const listeners = [];
  let current = null;
  const session = {
    send: async ({ prompt }) => {
      current.prompt = prompt;
      for (const step of scripts[attempts.length - 1]) {
        await step({ emit: (event) => listeners.forEach((fn) => fn(event)), session });
      }
    },
    abort: async () => {},
    on: (fn) => {
      listeners.push(fn);
      return () => listeners.splice(listeners.indexOf(fn), 1);
    },
  };
  const client = { stop: async () => [] };
  return {
    attempts,
    createRuntime: async (config) => {
      current = { ...config };
      attempts.push(current);
      return { client, session };
    },
  };
}

const complete = [
  [async ({ emit }) => {
    emit({ type: "assistant.message", data: { content: validLaneText([{ severity: "P2", title: "t" }]) } });
    emit({ type: "session.idle" });
  }],
];

describe("resolveMode (C1)", () => {
  it("returns the built-in topology unchanged when config defines no modes", () => {
    const lanes = resolveMode("balanced", defaultConfig());
    assert.deepEqual(lanes, LANE_TOPOLOGIES.balanced);
  });

  it("resolves a custom mode into an ordered list of built-in lanes and role lanes", () => {
    const config = defaultConfig();
    config.roles = { "api-hygiene": { prompt: "API design and hygiene.", tier: "medium" } };
    config.modes = { "hygiene-first": ["overview", "api-hygiene", "correctness"] };
    const lanes = resolveMode("hygiene-first", config);
    assert.deepEqual(lanes.map((lane) => lane.id), ["overview", "api-hygiene", "correctness"]);
    assert.equal(lanes[0].custom, undefined, "built-in lanes stay code-owned descriptors");
    const role = lanes[1];
    assert.equal(role.custom, true);
    assert.equal(role.tier, "medium");
    assert.equal(role.objective, "API design and hygiene.");
    assert.equal(role.model, undefined);
    assert.equal(role.effort, undefined);
  });

  it("carries role model/effort overrides onto the resolved lane", () => {
    const config = defaultConfig();
    config.roles = {
      "fast-pass": { prompt: "p", tier: "light", model: "zai/glm-4.6-air", effort: "minimal" },
      "session-lane": { prompt: "p", tier: "heavy", model: null },
    };
    config.modes = { custom: ["fast-pass", "session-lane"] };
    const [fast, sessionLane] = resolveMode("custom", config);
    assert.equal(fast.model, "zai/glm-4.6-air");
    assert.equal(fast.effort, "minimal");
    assert.equal(sessionLane.model, null, "an explicit null override means the session model");
    assert.equal(sessionLane.effort, undefined);
  });

  it("lets config.modes override a standard mode name", () => {
    const config = defaultConfig();
    config.roles = { extra: { prompt: "p", tier: "light" } };
    config.modes = { deep: ["overview", "extra"] };
    const lanes = resolveMode("deep", config);
    assert.deepEqual(lanes.map((lane) => lane.id), ["overview", "extra"]);
  });

  it("resolves built-in lane ids that repeat across topologies to the first definition (quick-first order)", () => {
    const config = defaultConfig();
    config.modes = { custom: ["correctness"] };
    const [lane] = resolveMode("custom", config);
    assert.equal(lane.objective, LANE_TOPOLOGIES.quick[0].objective);
  });

  it("fails on an unknown mode, an unknown lane id, and an empty list", () => {
    const config = defaultConfig();
    assert.throws(() => resolveMode("thorough", config), /unknown mode "thorough"/);
    const ghost = defaultConfig();
    ghost.modes = { custom: ["ghost"] };
    assert.throws(() => resolveMode("custom", ghost), /neither a defined role nor a built-in lane id/);
    const empty = defaultConfig();
    empty.modes = { custom: [] };
    assert.throws(() => resolveMode("custom", empty), /empty lane list/);
  });

  it("lists standard modes plus config-defined ones as selectable", () => {
    const config = defaultConfig();
    config.modes = { turbo: ["overview"] };
    assert.deepEqual(selectableModes(config), ["quick", "balanced", "full", "deep", "turbo"]);
  });

  it("enumerates the built-in lane ids (role-id collision surface)", () => {
    assert.deepEqual(builtinLaneIds().sort(), [
      "conventions-maintainability",
      "correctness",
      "correctness-contracts",
      "deep-review",
      "overview",
      "performance-resources",
      "security-performance",
    ]);
  });
});

describe("runLane with a custom role lane (C1)", () => {
  it("applies the role's model and effort over the tier's values", async () => {
    const { createRuntime, attempts } = fakeRuntime(complete);
    const lanes = {
      lane: { id: "api-hygiene", tier: "heavy", objective: "API design.", custom: true, model: "zai/glm-4.6-air", effort: "medium" },
    };
    const config = structuredClone(laneConfig);
    config.tiers.heavy.model = "tier-model";
    const outcome = await runLane({
      lane: lanes.lane,
      envelope: ENVELOPE,
      config,
      repoRoot: process.cwd(),
      deadlineAt: Date.now() + 60_000,
      createRuntime,
    });
    assert.equal(outcome.status, "complete");
    assert.equal(attempts[0].model, "zai/glm-4.6-air", "role model wins over the tier model");
    assert.equal(attempts[0].reasoningEffort, "medium", "role effort wins over the tier effort");
    assert.match(attempts[0].prompt, /"api-hygiene" lane \(heavy tier\)/);
    assert.match(attempts[0].prompt, /API design\./);
  });

  it("falls back to the tier's model/effort when the role sets none", async () => {
    const { createRuntime, attempts } = fakeRuntime(complete);
    const config = structuredClone(laneConfig);
    config.tiers.heavy.model = "tier-model";
    await runLane({
      lane: { id: "api-hygiene", tier: "heavy", objective: "API design.", custom: true },
      envelope: ENVELOPE,
      config,
      repoRoot: process.cwd(),
      deadlineAt: Date.now() + 60_000,
      createRuntime,
    });
    assert.equal(attempts[0].model, "tier-model");
    assert.equal(attempts[0].reasoningEffort, "high");
  });

  it("treats a null role model as the session model (no model pinned)", async () => {
    const { createRuntime, attempts } = fakeRuntime(complete);
    const config = structuredClone(laneConfig);
    config.tiers.heavy.model = "tier-model";
    await runLane({
      lane: { id: "x", tier: "heavy", objective: "o", custom: true, model: null },
      envelope: ENVELOPE,
      config,
      repoRoot: process.cwd(),
      deadlineAt: Date.now() + 60_000,
      createRuntime,
    });
    assert.equal(attempts[0].model, undefined);
  });
});

describe("runLaneBatch attempt plan with a role model (C1)", () => {
  it("uses the role model as primary/retry and the tier fallback when configured", async () => {
    const malformed = [
      [async ({ emit }) => {
        emit({ type: "assistant.message", data: { content: "no markers at all" } });
        emit({ type: "session.idle" });
      }],
      complete[0],
    ];
    const { createRuntime } = fakeRuntime(malformed);
    const config = structuredClone(laneConfig);
    config.tiers.heavy.fallback = "fb-model";
    const batch = await runLaneBatch({
      mode: "custom",
      lanes: [{ id: "api-hygiene", tier: "heavy", objective: "API design.", custom: true, model: "role-model" }],
      envelope: ENVELOPE,
      config,
      repoRoot: process.cwd(),
      createRuntime,
    });
    assert.equal(batch.status, "complete");
    assert.deepEqual(
      batch.lanes[0].attempts.map((attempt) => ({ label: attempt.label, model: attempt.model })),
      [
        { label: "primary", model: "role-model" },
        { label: "fallback", model: "fb-model" },
      ],
    );
  });
});
