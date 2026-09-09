import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPTURE_SCHEMA_VERSION,
  CAPTURED_PR_FIELDS,
  CaptureError,
  capturePullRequest,
} from "../extensions/pr-review/capture.mjs";

// A fake gh: commands are scripted by their exact argv join; anything not
// scripted fails loudly so tests cannot silently exercise the real gh. The
// returned shape matches defaultRunGh's contract: stdout/stderr are always
// strings.
function fakeGh(script) {
  return async (args) => {
    const key = args.join(" ");
    const entry = script[key];
    if (entry === undefined) {
      return { code: 127, stdout: "", stderr: `fake gh: unscripted command: gh ${key}`, timedOut: false };
    }
    if (typeof entry === "function") return entry();
    const base = { code: 0, stdout: "", stderr: "", timedOut: false };
    return typeof entry === "string" ? { ...base, stdout: entry } : { ...base, ...entry };
  };
}

const HEAD = "aaaaaaaabbbbbbbbccccccccdddddddd11111111";
const BASE = "aaaaaaaabbbbbbbbccccccccdddddddd22222222";

function prMetadata(overrides = {}) {
  return {
    number: 3,
    title: "feat(i2): capture",
    state: "OPEN",
    isDraft: false,
    headRefName: "i2-capture",
    headRefOid: HEAD,
    baseRefName: "main",
    baseRefOid: BASE,
    author: { login: "xpepper" },
    updatedAt: "2026-09-10T10:00:00Z",
    url: "https://github.com/xpepper/pr-review-glm/pull/3",
    headRepositoryOwner: { login: "xpepper" },
    ...overrides,
  };
}

function defaultScript(pr = prMetadata(), diff = "diff --git a/a b/a\n+hello\n") {
  return {
    "auth status": "",
    "repo view --json nameWithOwner": JSON.stringify({ nameWithOwner: "xpepper/pr-review-glm" }),
    [`pr view ${pr.number} --json ${CAPTURED_PR_FIELDS.join(",")}`]: JSON.stringify(pr),
    [`pr diff ${pr.number}`]: diff,
    [`pr view ${pr.number} --json headRefOid,baseRefOid`]: JSON.stringify({
      headRefOid: pr.headRefOid,
      baseRefOid: pr.baseRefOid,
    }),
  };
}

// Removes every command the capture flow runs after the lifecycle gates, so
// any regression that fetches the diff before gating fails loudly as an
// unscripted command instead of passing silently.
function noPostGateFetches(script, number = 3) {
  delete script[`pr diff ${number}`];
  delete script[`pr view ${number} --json headRefOid,baseRefOid`];
  return script;
}

const tempRoots = [];

async function captureWith(script, options = {}) {
  const tempRoot = mkdtempSync(join(tmpdir(), "pr-review-glm-test-"));
  tempRoots.push(tempRoot);
  return capturePullRequest({
    number: 3,
    runGh: fakeGh(script),
    tempRoot,
    now: () => new Date("2026-09-10T12:00:00.000Z"),
    ...options,
  });
}

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe("capturePullRequest — happy path", () => {
  it("writes a 0600 envelope that freezes the repo/PR binding and the diff", async () => {
    const outcome = await captureWith(defaultScript());
    assert.equal(outcome.status, "captured");
    const { summary, path, envelope } = outcome;

    assert.equal(summary.repo, "xpepper/pr-review-glm");
    assert.equal(summary.number, 3);
    assert.equal(summary.state, "OPEN");
    assert.equal(summary.isDraft, false);
    assert.equal(summary.author, "xpepper");
    assert.equal(summary.headOid, HEAD);
    assert.equal(summary.baseOid, BASE);
    assert.equal(summary.capturedAt, "2026-09-10T12:00:00.000Z");
    assert.equal(summary.capturePath, path);

    assert.equal(statSync(path).mode & 0o777, 0o600, "capture file must be 0600");
    const directory = readdirSync(join(path, ".."));
    assert.equal(directory.length, 1, "no stray files in the capture dir");
    assert(directory[0].startsWith("capture-xpepper-pr-review-glm-3-"), directory[0]);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(onDisk, {
      kind: "pr-review-glm-capture",
      schemaVersion: CAPTURE_SCHEMA_VERSION,
      capturedAt: "2026-09-10T12:00:00.000Z",
      repo: "xpepper/pr-review-glm",
      pr: {
        number: 3,
        title: "feat(i2): capture",
        state: "OPEN",
        isDraft: false,
        author: "xpepper",
        url: "https://github.com/xpepper/pr-review-glm/pull/3",
        updatedAt: "2026-09-10T10:00:00Z",
        base: { refName: "main", oid: BASE },
        head: { refName: "i2-capture", oid: HEAD, repositoryOwner: "xpepper" },
      },
      diff: "diff --git a/a b/a\n+hello\n",
    });
    assert.equal(onDisk.diff, "diff --git a/a b/a\n+hello\n", "diff preserved byte-for-byte");
  });

  it("records a fork's head owner while keeping the binding on the base repo", async () => {
    const outcome = await captureWith(
      defaultScript(prMetadata({ headRepositoryOwner: { login: "some-fork" } })),
    );
    assert.equal(outcome.envelope.pr.head.repositoryOwner, "some-fork");
    assert.equal(outcome.envelope.repo, "xpepper/pr-review-glm");
  });
});

describe("capturePullRequest — lifecycle gates", () => {
  it("skips drafts without --include-drafts and writes nothing", async () => {
    // The script stops after the metadata fetch: the gates must decide before
    // any diff is fetched (the fake gh fails loudly if they do not).
    const outcome = await captureWith(noPostGateFetches(defaultScript(prMetadata({ isDraft: true }))));
    assert.equal(outcome.status, "skipped");
    assert(outcome.message.includes("draft"));
    assert(outcome.message.includes("--include-drafts"));
    assert.equal(readdirSync(tempRoots.at(-1)).length, 0, "no capture dir may be created");
  });

  it("captures drafts with --include-drafts", async () => {
    const outcome = await captureWith(defaultScript(prMetadata({ isDraft: true })), {
      includeDrafts: true,
    });
    assert.equal(outcome.status, "captured");
    assert.equal(outcome.summary.isDraft, true);
  });

  for (const state of ["CLOSED", "MERGED"]) {
    it(`skips ${state} PRs without --include-closed`, async () => {
      const outcome = await captureWith(noPostGateFetches(defaultScript(prMetadata({ state }))));
      assert.equal(outcome.status, "skipped");
      assert(outcome.message.includes(state));
      assert(outcome.message.includes("--include-closed"));
    });

    it(`captures ${state} PRs with --include-closed`, async () => {
      const outcome = await captureWith(defaultScript(prMetadata({ state })), {
        includeClosed: true,
      });
      assert.equal(outcome.status, "captured");
    });
  }

  it("lets a draft+closed PR through only with both flags", async () => {
    const script = defaultScript(prMetadata({ state: "MERGED", isDraft: true }));
    const refused = await captureWith(noPostGateFetches({ ...script }));
    assert.equal(refused.status, "skipped");
    const outcome = await captureWith(script, { includeDrafts: true, includeClosed: true });
    assert.equal(outcome.status, "captured");
  });
});

describe("capturePullRequest — fail-closed refusals", () => {
  async function assertRefuses(script, fragment, options) {
    await assert.rejects(
      () => captureWith(script, options),
      (error) => {
        assert.ok(error instanceof CaptureError, `expected CaptureError, got ${error}`);
        assert(error.message.includes(fragment), `${error.message} must mention "${fragment}"`);
        return true;
      },
    );
    assert.equal(readdirSync(tempRoots.at(-1)).length, 0, "nothing may be written when capture refuses");
  }

  it("refuses when gh is not authenticated", async () => {
    const script = defaultScript();
    script["auth status"] = { code: 1, stderr: "You are not logged into any GitHub hosts." };
    await assertRefuses(script, "authentication");
  });

  it("refuses when the repo binding cannot be resolved", async () => {
    const script = defaultScript();
    script["repo view --json nameWithOwner"] = { code: 128, stderr: "not a git repository" };
    await assertRefuses(script, "resolving the repository");
  });

  it("refuses when gh pr view fails, surfacing gh's stderr", async () => {
    const script = defaultScript();
    script[`pr view 3 --json ${CAPTURED_PR_FIELDS.join(",")}`] = {
      code: 1,
      stderr: "no pull requests found",
    };
    await assertRefuses(script, "no pull requests found");
  });

  it("refuses when gh pr view returns malformed JSON", async () => {
    const script = defaultScript();
    script[`pr view 3 --json ${CAPTURED_PR_FIELDS.join(",")}`] = "<html>not json</html>";
    await assertRefuses(script, "malformed JSON");
  });

  it("refuses when the returned PR number differs from the requested one", async () => {
    // The fake answers the requested PR #3, but its payload claims PR #4 —
    // the binding gh echoed must match the binding we froze.
    const script = defaultScript();
    script[`pr view 3 --json ${CAPTURED_PR_FIELDS.join(",")}`] = JSON.stringify(prMetadata({ number: 4 }));
    await assertRefuses(script, "inconsistent");
  });

  it("refuses on an unrecognized PR state", async () => {
    await assertRefuses(defaultScript(prMetadata({ state: "SOMETHING" })), "unrecognized state");
  });

  it("refuses on a non-boolean isDraft (draft gate must fail closed)", async () => {
    // gh omits absent booleans in JSON, so the missing case matters too.
    const missing = defaultScript(prMetadata());
    missing[`pr view 3 --json ${CAPTURED_PR_FIELDS.join(",")}`] = JSON.stringify(
      prMetadata({ isDraft: undefined }),
    );
    await assertRefuses(missing, "malformed isDraft");
    await assertRefuses(defaultScript(prMetadata({ isDraft: 1 })), "malformed isDraft");
  });

  it("refuses on non-string metadata fields", async () => {
    await assertRefuses(defaultScript(prMetadata({ title: 42 })), "malformed metadata (title)");
    await assertRefuses(defaultScript(prMetadata({ headRefName: null })), "malformed metadata (headRefName)");
  });

  it("refuses on malformed head/base oids", async () => {
    await assertRefuses(defaultScript(prMetadata({ headRefOid: "short" })), "malformed headRefOid");
    await assertRefuses(defaultScript(prMetadata({ baseRefOid: null })), "malformed baseRefOid");
  });

  it("refuses when head and base point at the same commit", async () => {
    await assertRefuses(defaultScript(prMetadata({ headRefOid: BASE, baseRefOid: BASE })), "same commit");
  });

  it("refuses on an empty diff", async () => {
    await assertRefuses(defaultScript(prMetadata(), ""), "empty diff");
  });

  it("refuses when the PR head moves between the metadata and diff fetches", async () => {
    const script = defaultScript();
    script["pr view 3 --json headRefOid,baseRefOid"] = JSON.stringify({
      headRefOid: "aaaaaaaabbbbbbbbccccccccdddddddd33333333",
      baseRefOid: BASE,
    });
    await assertRefuses(script, "changed while it was being captured");
  });

  it("refuses when the head re-check itself fails or returns malformed JSON", async () => {
    const failing = defaultScript();
    failing["pr view 3 --json headRefOid,baseRefOid"] = { code: 1, stderr: "boom" };
    await assertRefuses(failing, "re-checking the head");
    const malformed = defaultScript();
    malformed["pr view 3 --json headRefOid,baseRefOid"] = "not json";
    await assertRefuses(malformed, "malformed JSON");
  });

  it("refuses when gh pr diff fails", async () => {
    const script = defaultScript();
    script["pr diff 3"] = { code: 1, stderr: "GraphQL: Could not resolve" };
    await assertRefuses(script, "Could not resolve");
  });

  it("refuses when a gh call times out", async () => {
    const script = defaultScript();
    script["pr diff 3"] = { code: null, stdout: "", stderr: "", timedOut: true };
    await assertRefuses(script, "timed out");
  });

  it("refuses an invalid PR number before running gh", async () => {
    // fakeGh({}) scripts nothing: any gh call would fail loudly, proving the
    // number check happens first.
    await assert.rejects(() => captureWith({}, { number: 0 }), (error) => {
      assert.ok(error instanceof CaptureError);
      assert(error.message.includes("positive integer"));
      return true;
    });
  });
});
