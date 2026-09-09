// Read-only PR capture: fetches PR metadata and diff via `gh` and freezes the
// repo/PR binding into a 0600 temp file. Pure code — the session model is
// never involved (spec: capture is fail-closed and inference-free).

import { execFile } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const CAPTURE_SCHEMA_VERSION = 1;

// Everything later stages need from `gh pr view`; kept explicit so the frozen
// envelope shape is visible in one place.
export const CAPTURED_PR_FIELDS = [
  "number",
  "title",
  "state",
  "isDraft",
  "headRefName",
  "headRefOid",
  "baseRefName",
  "baseRefOid",
  "author",
  "updatedAt",
  "url",
  "headRepositoryOwner",
];

const PR_STATES = ["OPEN", "CLOSED", "MERGED"];
const OID_PATTERN = /^[0-9a-f]{40}$/;
const DEFAULT_GH_TIMEOUT_MS = 30_000;

export class CaptureError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "CaptureError";
  }
}

// The subprocess boundary. Always resolves — failures are reported as a
// non-zero `code` (or `timedOut`) so callers stay in fail-closed logic.
// Injected as `runGh` by tests.
async function defaultRunGh(args, { cwd, timeoutMs }) {
  try {
    const { stdout, stderr } = await promisify(execFile)("gh", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr, timedOut: false };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? (error.killed ? "" : String(error)),
      timedOut: error.killed === true,
    };
  }
}

async function runGhOrThrow(runGh, args, cwd, doingWhat) {
  const result = await runGh(args, { cwd, timeoutMs: DEFAULT_GH_TIMEOUT_MS });
  if (result.code === 0) return result.stdout;
  if (result.timedOut) {
    throw new CaptureError(`gh failed while ${doingWhat}: timed out after ${DEFAULT_GH_TIMEOUT_MS}ms. Failing closed.`);
  }
  const detail = firstLine(result.stderr || result.stdout || "no output");
  throw new CaptureError(`gh failed while ${doingWhat} (exit ${result.code}): ${detail}`);
}

function firstLine(text) {
  return text.trim().split("\n")[0] ?? "";
}

function parseJsonOrThrow(text, doingWhat) {
  try {
    return JSON.parse(text);
  } catch {
    throw new CaptureError(`gh returned malformed JSON while ${doingWhat}; failing closed.`);
  }
}

/**
 * Captures PR `number` from the repository that `cwd` resolves to.
 *
 * Resolves to:
 *   { status: "skipped", message }   — draft/closed lifecycle gate declined the PR
 *   { status: "captured", summary, path, envelope }
 *
 * Throws CaptureError on every fail-closed condition (unauthenticated gh,
 * gh failures, inconsistent repo/head state, empty diff). Nothing is written
 * unless every check has passed.
 */
export async function capturePullRequest({
  number,
  includeDrafts = false,
  includeClosed = false,
  cwd = process.cwd(),
  runGh = defaultRunGh,
  tempRoot = tmpdir(),
  now = () => new Date(),
}) {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new CaptureError(`PR number must be a positive integer (got ${JSON.stringify(number)}).`);
  }

  await runGhOrThrow(runGh, ["auth", "status"], cwd, "checking gh authentication");
  const repoJson = parseJsonOrThrow(
    await runGhOrThrow(runGh, ["repo", "view", "--json", "nameWithOwner"], cwd, "resolving the repository"),
    "resolving the repository",
  );
  const repo = repoJson?.nameWithOwner;
  if (typeof repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new CaptureError(`gh reported an unusable repository binding: ${JSON.stringify(repo)}.`);
  }

  const pr = parseJsonOrThrow(
    await runGhOrThrow(
      runGh,
      ["pr", "view", String(number), "--json", CAPTURED_PR_FIELDS.join(",")],
      cwd,
      `fetching PR #${number}`,
    ),
    `fetching PR #${number}`,
  );

  // Consistency checks: the binding we freeze must match what gh actually
  // returned, and the head/base must be well-formed and distinct.
  if (pr?.number !== number) {
    throw new CaptureError(
      `gh returned PR #${pr?.number} for requested #${number}; repository state is inconsistent. Failing closed.`,
    );
  }
  if (!PR_STATES.includes(pr.state)) {
    throw new CaptureError(`PR #${number} has an unrecognized state "${pr.state}"; failing closed.`);
  }
  for (const [label, oid] of [
    ["headRefOid", pr.headRefOid],
    ["baseRefOid", pr.baseRefOid],
  ]) {
    if (typeof oid !== "string" || !OID_PATTERN.test(oid)) {
      throw new CaptureError(`PR #${number} has a malformed ${label}; failing closed.`);
    }
  }
  if (pr.headRefOid === pr.baseRefOid) {
    throw new CaptureError(
      `PR #${number} head and base point at the same commit (${pr.headRefOid}); the PR state is inconsistent.`,
    );
  }

  // Lifecycle gates: skip (do not fail) drafts and closed/merged PRs unless
  // explicitly included. --capture-only never prompts interactively.
  if (pr.isDraft === true && !includeDrafts) {
    return {
      status: "skipped",
      message: `Skipped: PR #${number} is a draft. Re-run with --include-drafts to capture it anyway.`,
    };
  }
  if (pr.state !== "OPEN" && !includeClosed) {
    return {
      status: "skipped",
      message: `Skipped: PR #${number} is ${pr.state}. Re-run with --include-closed to capture it anyway.`,
    };
  }

  const diff = await runGhOrThrow(runGh, ["pr", "diff", String(number)], cwd, `fetching the diff of PR #${number}`);
  if (diff.length === 0) {
    throw new CaptureError(`PR #${number} has an empty diff; there is nothing to review.`);
  }

  const capturedAt = now();
  const envelope = {
    kind: "pr-review-glm-capture",
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    capturedAt: capturedAt.toISOString(),
    repo,
    pr: {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      isDraft: pr.isDraft === true,
      author: pr.author?.login ?? null,
      url: pr.url,
      updatedAt: pr.updatedAt,
      base: { refName: pr.baseRefName, oid: pr.baseRefOid },
      head: {
        refName: pr.headRefName,
        oid: pr.headRefOid,
        repositoryOwner: pr.headRepositoryOwner?.login ?? null,
      },
    },
    diff,
  };
  const summary = {
    repo,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft === true,
    author: envelope.pr.author,
    headRefName: pr.headRefName,
    headOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    baseOid: pr.baseRefOid,
    diffBytes: Buffer.byteLength(diff, "utf8"),
    capturedAt: envelope.capturedAt,
    capturePath: null,
  };

  const directory = await mkdtemp(join(tempRoot, "pr-review-glm-"));
  const path = join(
    directory,
    `capture-${repo.replace("/", "-")}-${number}-${capturedAt.toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(path, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  summary.capturePath = path;

  return { status: "captured", summary, path, envelope };
}
