import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseConfigArgs,
  parseReviewArgs,
  renderCapture,
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

  it("parses a bare PR number into a review invocation with default flags", () => {
    assert.deepEqual(parseReviewArgs("42"), {
      kind: "review",
      number: 42,
      flags: {
        captureOnly: false,
        includeDrafts: false,
        includeClosed: false,
        mode: null,
        comment: null,
        all: false,
      },
    });
  });

  it("parses the full spec flag grammar", () => {
    assert.deepEqual(parseReviewArgs("123 --capture-only --include-closed --include-drafts"), {
      kind: "review",
      number: 123,
      flags: {
        captureOnly: true,
        includeDrafts: true,
        includeClosed: true,
        mode: null,
        comment: null,
        all: false,
      },
    });
    assert.deepEqual(parseReviewArgs("7 --deep --no-comment --all"), {
      kind: "review",
      number: 7,
      flags: {
        captureOnly: false,
        includeDrafts: false,
        includeClosed: false,
        mode: "deep",
        comment: false,
        all: true,
      },
    });
  });

  it("rejects inputs that are not PR-number invocations, naming the input", () => {
    for (const args of ["inspect", "cancel", "capture 5", "five", "-5", "0", "007", "--capture-only", "--quick"]) {
      const result = parseReviewArgs(args);
      assert.equal(result.kind, "error", args);
      assert(result.message.includes(args), args);
      assert(result.message.includes("PR number"), args);
    }
  });

  it("rejects unknown and repeated flags", () => {
    for (const args of ["5 --bogus", "5 --capture-only --capture-only", "5 --quick --quick", "5 --include-drafts --include-drafts"]) {
      const result = parseReviewArgs(args);
      assert.equal(result.kind, "error", args);
      assert(result.message.includes("Run /pr-review help"), args);
    }
  });

  it("rejects contradictory flag combinations", () => {
    for (const [args, fragment] of [
      ["5 --quick --full", "Only one mode flag"],
      ["5 --comment --no-comment", "--comment or --no-comment"],
      ["5 --capture-only --quick", "no effect with --capture-only"],
      ["5 --capture-only --comment", "no effect with --capture-only"],
      ["5 --capture-only --no-comment", "no effect with --capture-only"],
      ["5 --capture-only --all", "no effect with --capture-only"],
    ]) {
      const result = parseReviewArgs(args);
      assert.equal(result.kind, "error", args);
      assert(result.message.includes(fragment), `${args}: ${result.message}`);
    }
  });

  it("keeps --include-drafts and --include-closed meaningful with --capture-only", () => {
    assert.equal(parseReviewArgs("5 --capture-only --include-drafts --include-closed").kind, "review");
  });
});

describe("renderStatus / renderHelp / renderCapture", () => {
  const captureSummary = {
    repo: "xpepper/pr-review-glm",
    number: 3,
    title: "feat(i1): plugin skeleton + configuration",
    state: "MERGED",
    isDraft: false,
    author: "xpepper",
    headRefName: "i1-plugin-skeleton",
    headOid: "0cd2187465ea37aef14626a09be396f0c37898b1",
    baseRefName: "main",
    baseOid: "8b476fd4741afc65f17d829fd307ebc62c276167",
    diffBytes: 70965,
    capturedAt: "2026-09-10T10:00:00.000Z",
    capturePath: "/tmp/pr-review-glm-abc/capture-xpepper-pr-review-glm-3-2026-09-10T10-00-00-000Z.json",
  };

  it("status states the capability boundary without promising a review", () => {
    const text = renderStatus();
    assert(text.includes("pr-review-glm"));
    assert(text.includes("no model calls"), "must state that it makes no model calls");
    assert(text.includes("--capture-only"), "must name capture as implemented");
    assert(text.includes("I3"), "must name the next increment");
    assert(!text.includes("Last capture"), "no capture section without a capture");
  });

  it("status reports the session's last capture when one exists", () => {
    const text = renderStatus(captureSummary);
    assert(text.includes("Last capture (this session)"));
    assert(text.includes("PR #3 xpepper/pr-review-glm — MERGED"));
    assert(text.includes("0cd2187"), "must show a short head oid");
    assert(text.includes("8b476fd"), "must show a short base oid");
    assert(text.includes("70,965"), "must show the diff size");
    assert(text.includes(captureSummary.capturePath));
  });

  it("renderCapture reports the frozen binding, gates context, and zero inference", () => {
    const text = renderCapture(captureSummary);
    assert(text.includes('Captured PR #3 — "feat(i1): plugin skeleton + configuration" (MERGED)'));
    assert(text.includes("Repository: xpepper/pr-review-glm (binding frozen at capture time)"));
    assert(text.includes("Head: i1-plugin-skeleton @ 0cd2187 -> Base: main @ 8b476fd"));
    assert(text.includes("70,965 bytes"));
    assert(text.includes("No model calls"));
  });

  it("renderCapture labels draft captures", () => {
    const text = renderCapture({ ...captureSummary, isDraft: true, state: "OPEN" });
    assert(text.includes("(OPEN, draft)"));
  });

  it("help shows usage for status, help, and capture", () => {
    const text = renderHelp();
    assert(text.includes("/pr-review status"));
    assert(text.includes("/pr-review help"));
    assert(text.includes("--capture-only"));
    assert(text.includes("--include-drafts"));
    assert(text.includes("--include-closed"));
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
