import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseConfigArgs,
  parseReviewArgs,
  renderConfigHelp,
  renderConfigShow,
  renderHelp,
  renderStatus,
} from "../extensions/pr-review/commands.mjs";
import { CONFIG_SCHEMA_VERSION, ConfigStore } from "../extensions/pr-review/config.mjs";

describe("parseReviewArgs", () => {
  it("treats empty args and status as the status subcommand", () => {
    assert.deepEqual(parseReviewArgs(""), { kind: "status" });
    assert.deepEqual(parseReviewArgs("status"), { kind: "status" });
  });

  it("treats help and --help as the help subcommand", () => {
    assert.deepEqual(parseReviewArgs("help"), { kind: "help" });
    assert.deepEqual(parseReviewArgs("--help"), { kind: "help" });
  });

  it("rejects anything else as not implemented yet, naming the input", () => {
    for (const args of ["42", "123 --quick", "capture-only 5", "inspect", "cancel"]) {
      const result = parseReviewArgs(args);
      assert.equal(result.kind, "error");
      assert(result.message.includes("not implemented"), args);
      assert(result.message.includes("help"), "error must point at help");
    }
  });
});

describe("renderStatus / renderHelp", () => {
  it("status states the capability boundary without promising a review", () => {
    const text = renderStatus();
    assert(text.includes("pr-review-glm"));
    assert(text.includes("no model calls"), "must state that it makes no model calls");
    assert(text.includes("configuration"), "must name what works today");
    assert(text.includes("capture"), "must name the next increment");
    assert(!text.toLowerCase().includes("running a review"), "must not imply reviews work yet");
  });

  it("help shows usage for the registered subcommands only", () => {
    const text = renderHelp();
    assert(text.includes("/pr-review"));
    assert(text.includes("status"));
    assert(text.includes("help"));
    assert(text.includes("/pr-review-config"));
  });
});

describe("parseConfigArgs", () => {
  it("treats empty args and show as the show subcommand", () => {
    assert.deepEqual(parseConfigArgs(""), { kind: "show" });
    assert.deepEqual(parseConfigArgs("show"), { kind: "show" });
  });

  it("treats help and --help as the help subcommand", () => {
    assert.deepEqual(parseConfigArgs("help"), { kind: "help" });
    assert.deepEqual(parseConfigArgs("--help"), { kind: "help" });
  });

  it("parses one or more key=value pairs into a set operation", () => {
    assert.deepEqual(parseConfigArgs("defaultMode=full"), {
      kind: "set",
      entries: [["defaultMode", "full"]],
    });
    assert.deepEqual(parseConfigArgs("tiers.heavy.model=gpt-5.6-terra autoPostReviews=true deadlines.batchMs=300000"), {
      kind: "set",
      entries: [
        ["tiers.heavy.model", "gpt-5.6-terra"],
        ["autoPostReviews", "true"],
        ["deadlines.batchMs", "300000"],
      ],
    });
  });

  it("keeps equals signs inside values", () => {
    assert.deepEqual(parseConfigArgs("tiers.heavy.model=a=b"), {
      kind: "set",
      entries: [["tiers.heavy.model", "a=b"]],
    });
  });

  it("parses unset with one or more keys", () => {
    assert.deepEqual(parseConfigArgs("unset tiers.heavy.fallback"), {
      kind: "unset",
      keys: ["tiers.heavy.fallback"],
    });
    assert.deepEqual(parseConfigArgs("unset defaultMode autoPostReviews"), {
      kind: "unset",
      keys: ["defaultMode", "autoPostReviews"],
    });
  });

  it("rejects malformed input with usage guidance", () => {
    for (const args of ["set", "unset", "unset-show", "defaultMode", "=full", "defaultMode=", "show defaultMode=full"]) {
      const result = parseConfigArgs(args);
      assert.equal(result.kind, "error", args);
      assert(result.message.includes("Usage"), args);
    }
  });
});

describe("renderConfigShow / renderConfigHelp", () => {
  async function makeStore() {
    const dir = mkdtempSync(join(tmpdir(), "pr-review-glm-cmd-"));
    const store = new ConfigStore(join(dir, "config.json"));
    await store.load();
    return store;
  }

  it("renders defaults with their source when no file exists", async () => {
    const store = await makeStore();
    const text = renderConfigShow(store);
    assert(text.includes(store.path));
    assert(text.includes("defaults"));
    assert(text.includes(`schemaVersion: ${CONFIG_SCHEMA_VERSION}`));
    assert(text.includes("defaultMode: balanced"));
    assert(text.includes("autoPostReviews: false"));
    assert(text.includes("tiers.heavy.model: null"));
    assert(text.includes("deadlines.totalMs: 900000"));
  });

  it("renders file state after a set and surfaces load warnings", async () => {
    const store = await makeStore();
    await store.set([["defaultMode", "deep"], ["tiers.heavy.model", "gpt-5.6-terra"]]);
    const text = renderConfigShow(store);
    assert(text.includes("file"));
    assert(text.includes("defaultMode: deep"));
    assert(text.includes("tiers.heavy.model: gpt-5.6-terra"));
    assert(text.includes("fallback: (unset)") || text.includes("fallback"));
  });

  it("config help documents show, set, and unset with the config path", async () => {
    const store = await makeStore();
    const text = renderConfigHelp(store);
    assert(text.includes("/pr-review-config show"));
    assert(text.includes("key=value"));
    assert(text.includes("unset key"));
    assert(text.includes(store.path));
  });
});

describe("renderConfigShow with a rejected file", () => {
  it("surfaces the load warning alongside the active defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-review-glm-warn-"));
    const store = new ConfigStore(join(dir, "config.json"));
    mkdirSync(join(store.path, ".."), { recursive: true });
    writeFileSync(store.path, "{ broken", { mode: 0o600 });
    await store.load();
    const text = renderConfigShow(store);
    assert(text.includes("Warning:"));
    assert(text.includes(store.path));
    assert(text.includes("defaultMode: balanced"), "defaults must render as the active state");
  });
});
