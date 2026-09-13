// I7: gated COMMENT publication — the write side of the review pipeline.
// Authority is code-owned only (spec: "Publication gates"): the invocation
// flag --comment or config autoPostReviews, both captured before lanes start
// (extension.mjs); model text never selects the event, commit, repo, or
// anchors. Publication posts ONE COMMENT review whose inline comments are the
// first ≤50 selected findings whose anchors re-validate against the live
// `pulls/N/files` hunks; everything else goes to body notes. Draft, closed,
// and self-author PRs are refused; a moved head degrades to a body-only
// comment naming both commits; an idempotency marker makes re-runs skip and
// lets an uncertain write response be reconciled. No selected findings means
// no POST at all.
import { spawn } from "node:child_process";

export const MAX_INLINE_ANCHORS = 50;
// GitHub's documented review-body cap is 65,536 characters; stop well short so
// composition can never trip the API's own limit instead of our gate.
export const MAX_BODY_CHARS = 60_000;
const DEFAULT_GH_TIMEOUT_MS = 30_000;
const FILES_PAGE_SIZE = 100;
const MAX_FILE_PAGES = 5; // 500 files; beyond that the anchor map fails closed
const REVIEWS_PAGE_SIZE = 100;
const MAX_REVIEW_PAGES = 10; // the marker scan reads every review page

export class PublishError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "PublishError";
  }
}

// The subprocess boundary (capture.mjs pattern, plus stdin so the POST body —
// nested JSON with the comments array — never touches argv). Built on `spawn`
// with an explicit stdin write: async `execFile` silently ignores an `input`
// option (it exists only on the *Sync variants), so the POST payload must be
// written to the child's stdin stream. Always resolves; failures surface as
// code/stderr/timedOut so the caller stays fail-closed.
export function defaultRunGh(args, { cwd, timeoutMs, stdin }) {
  const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn("gh", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES && !overflowed) {
        overflowed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
    }
    child.on("error", (error) => {
      finish({ code: 1, stdout, stderr: stderr || String(error), timedOut: timedOut || overflowed });
    });
    child.on("close", (code, signal) => {
      if (overflowed) {
        finish({ code: 1, stdout, stderr: "gh output exceeded the capture buffer", timedOut: false });
        return;
      }
      finish({
        code: code ?? (signal !== null ? 1 : 0),
        stdout,
        stderr,
        timedOut,
      });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
    child.stdin.on("error", () => {
      // The child died before reading stdin (spawn errors close the pipe);
      // the close/error handler reports the real failure.
    });
  });
}

// Model text is flattened and control-characters stripped before it reaches
// the GitHub payload; `<!--` is defused so finding text can never forge (or
// shadow) the idempotency marker.
function sanitize(text) {
  return String(text ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replaceAll("<!--", "<! --");
}

export function idempotencyMarker(repo, number, headOid) {
  return `<!-- z-pr-review ${repo}#${number}@${headOid} -->`;
}

// The selected findings of a retained review, in report order. The numbers are
// positions in the rendered report (I6), so a subset can only name findings
// that survived host validation, adjudication, and the mode policy.
export function selectedFindings(findings, selection) {
  if (selection.kind === "all") return [...findings];
  if (selection.kind === "none") return [];
  return selection.indexes.map((index) => findings[index - 1]);
}

// New-side hunk ranges of one file's `patch` (the same parsing contract as
// adjudicate.mjs, over the API's patch field instead of the captured diff).
function newSideRanges(patch) {
  const ranges = [];
  for (const line of String(patch).split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  return ranges;
}

// Anchor map from `pulls/N/files`: filename -> new-side hunk ranges. Files
// with no patch (binary, or too large for the API to inline) have no ranges —
// their findings are simply not inline-anchorable and go to body notes.
export function anchorMapFromFiles(filesJson) {
  const map = new Map();
  for (const file of filesJson) {
    if (typeof file?.filename !== "string") continue;
    map.set(file.filename, file.patch === undefined ? [] : newSideRanges(file.patch));
  }
  return map;
}

function anchorable(finding, anchorMap) {
  if (typeof finding.file !== "string" || typeof finding.line !== "number") return false;
  const ranges = anchorMap.get(finding.file);
  return ranges !== undefined && ranges.some(([start, end]) => finding.line >= start && finding.line <= end);
}

function commentBody(finding) {
  const lines = [`**[${finding.severity}] ${sanitize(finding.title)}** (z-pr-review, lane: ${sanitize(finding.lane)})`];
  if (finding.detail) lines.push("", sanitize(finding.detail));
  return lines.join("\n");
}

// Composes the single COMMENT review: header, optional body notes for every
// finding that did not become an inline comment, the coverage disclosure for
// non-complete reviews, and the idempotency marker. A stale head disables
// inline comments entirely — the body names both commits (spec's stale rule).
export function buildPublication({ capture, review, selected, anchorMap, currentHead, stale }) {
  const inline = [];
  const noted = [];
  for (const finding of selected) {
    if (!stale && inline.length < MAX_INLINE_ANCHORS && anchorable(finding, anchorMap)) {
      // `side: "RIGHT"` is required by the reviews API for a `line` anchor and
      // matches the anchor map, which is built from new-side hunk ranges only.
      inline.push({ path: finding.file, line: finding.line, side: "RIGHT", body: commentBody(finding) });
    } else {
      noted.push(finding);
    }
  }
  const lines = [`## z-pr-review review of PR #${capture.number} (${capture.repo})`];
  lines.push(
    `${selected.length} finding${selected.length === 1 ? "" : "s"} selected for publication — all host-validated against the diff captured at review time.`,
  );
  if (stale) {
    lines.push(
      "",
      `This review ran against head \`${capture.headOid}\`, but the PR head is now \`${currentHead}\` — findings are attached here rather than inline, and the moved commits are both named above.`,
    );
  }
  if (noted.length > 0) {
    lines.push("", "### Other notes");
    noted.forEach((finding, index) => {
      const location = finding.file ? ` — ${finding.file}${typeof finding.line === "number" ? `:${finding.line}` : ""}` : "";
      lines.push(`${index + 1}. **[${finding.severity}] ${sanitize(finding.title)}**${location}`);
      if (finding.detail) lines.push(`   ${sanitize(finding.detail)}`);
    });
  }
  if (review.status !== "complete") {
    const coverage = review.lanes.filter((lane) => lane.status === "complete").length;
    lines.push(
      "",
      `Coverage: ${coverage}/${review.lanes.length} lanes completed — ${review.status}${review.reason !== undefined ? ` (${review.reason})` : ""}. This is an incomplete review, never a clean one.`,
    );
  }
  lines.push("", idempotencyMarker(capture.repo, capture.number, currentHead));
  return { body: lines.join("\n"), inline, notedCount: noted.length };
}

async function ghJson(runGh, cwd, args, doingWhat, { stdin } = {}) {
  const result = await runGh(args, { cwd, timeoutMs: DEFAULT_GH_TIMEOUT_MS, ...(stdin === undefined ? {} : { stdin }) });
  if (result.code === 0) {
    try {
      return { ok: true, value: JSON.parse(result.stdout) };
    } catch {
      return { ok: false, detail: "malformed JSON" };
    }
  }
  const detail = firstLine(result.stderr || result.stdout || "no output");
  return { ok: false, detail: result.timedOut ? `timed out after ${DEFAULT_GH_TIMEOUT_MS}ms` : `exit ${result.code}: ${detail}` };
}

function firstLine(text) {
  return text.trim().split("\n")[0] ?? "";
}

async function ghJsonOrThrow(runGh, cwd, args, doingWhat, options = {}) {
  const result = await ghJson(runGh, cwd, args, doingWhat, options);
  if (!result.ok) {
    throw new PublishError(`gh failed while ${doingWhat}: ${result.detail}. Failing closed — nothing was posted.`);
  }
  return result.value;
}

// Paginates a list endpoint up to a page cap; more pages than the cap is a
// fail-closed condition (the anchor map or marker scan would be incomplete).
async function ghListOrThrow(runGh, cwd, path, { pageSize, maxPages, doingWhat }) {
  const all = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const args = ["api", `${path}?per_page=${pageSize}&page=${page}`];
    const batch = await ghJsonOrThrow(runGh, cwd, args, doingWhat);
    if (!Array.isArray(batch)) {
      throw new PublishError(`gh returned a non-array while ${doingWhat}; failing closed — nothing was posted.`);
    }
    all.push(...batch);
    if (batch.length < pageSize) return all;
  }
  throw new PublishError(`${doingWhat}: more than ${maxPages * pageSize} entries; failing closed — nothing was posted.`);
}

function httpStatusOf(stderr) {
  return /\(HTTP (\d+)\)/.exec(stderr)?.[1];
}

// Publishes the retained review's selected findings as ONE gated COMMENT
// review. Outcomes (never a silent partial write):
//   { status: "skipped", reason }            — no selected findings; no POST
//   { status: "refused", reason }            — a gate declined the PR; no POST
//   { status: "already-published", reviewUrl, marker } — idempotency skip
//   { status: "published", reviewUrl, inlineCount, notedCount, stale, reconciled }
// Throws PublishError on every fail-closed condition.
export async function publishReview({
  retained,
  authority,
  runGh = defaultRunGh,
  cwd = process.cwd(),
}) {
  const { capture, review, selection } = retained;
  const selected = selectedFindings(review.findings, selection);
  if (selected.length === 0) {
    return { status: "skipped", reason: "no findings are selected — nothing to publish." };
  }
  const prPath = `repos/${capture.repo}/pulls/${capture.number}`;

  // Lifecycle, self-author, and head gates read ONE fresh PR fetch; the
  // captured binding names the repo/PR, never a live one.
  const pr = await ghJsonOrThrow(runGh, cwd, ["api", prPath], `fetching PR #${capture.number} for publication gates`);
  if (pr.state !== "OPEN") {
    return { status: "refused", reason: `PR #${capture.number} is ${pr.state}; nothing was posted.` };
  }
  if (pr.draft === true) {
    return { status: "refused", reason: `PR #${capture.number} is a draft; nothing was posted.` };
  }
  const viewer = await ghJsonOrThrow(runGh, cwd, ["api", "user"], "resolving the authenticated gh user");
  if (typeof viewer?.login !== "string" || viewer.login === "") {
    throw new PublishError(`could not resolve the authenticated gh user; failing closed — nothing was posted.`);
  }
  const prAuthor = typeof pr.user?.login === "string" ? pr.user.login : null;
  if (prAuthor === null) {
    throw new PublishError(`PR #${capture.number} has no author login; the self-review gate cannot run, so failing closed — nothing was posted.`);
  }
  if (prAuthor === viewer.login) {
    return { status: "refused", reason: `PR #${capture.number} is authored by ${viewer.login} (you); self-review publication is refused.` };
  }
  const currentHead = pr.head?.sha;
  if (typeof currentHead !== "string" || !/^[0-9a-f]{40}$/.test(currentHead)) {
    throw new PublishError(`PR #${capture.number} has a malformed head sha; failing closed — nothing was posted.`);
  }
  const stale = currentHead !== capture.headOid;

  // Idempotency: a review carrying this exact marker already exists → skip.
  const marker = idempotencyMarker(capture.repo, capture.number, currentHead);
  const existingReviews = await ghListOrThrow(runGh, cwd, prPath + "/reviews", {
    pageSize: REVIEWS_PAGE_SIZE,
    maxPages: MAX_REVIEW_PAGES,
    doingWhat: "scanning existing reviews for the idempotency marker",
  });
  const prior = existingReviews.find((r) => typeof r.body === "string" && r.body.includes(marker));
  if (prior !== undefined) {
    return { status: "already-published", reviewUrl: prior.html_url ?? null, marker };
  }

  const files = await ghListOrThrow(runGh, cwd, prPath + "/files", {
    pageSize: FILES_PAGE_SIZE,
    maxPages: MAX_FILE_PAGES,
    doingWhat: "fetching the PR's changed files for anchor validation",
  });
  const publication = buildPublication({
    capture,
    review,
    selected,
    anchorMap: anchorMapFromFiles(files),
    currentHead,
    stale,
  });
  if (publication.body.length > MAX_BODY_CHARS) {
    throw new PublishError(
      `composed review body is ${publication.body.length} characters (cap ${MAX_BODY_CHARS}); failing closed — nothing was posted.`,
    );
  }

  // Final pre-write re-check: gates, files, and body were all composed against
  // the earlier fetch; if the PR closed, turned draft, or its head moved in
  // between, posting now would write against a state the gates never cleared.
  const recheck = await ghJsonOrThrow(runGh, cwd, ["api", prPath], "re-checking the PR immediately before posting");
  if (recheck.state !== "OPEN" || recheck.draft === true) {
    throw new PublishError(
      `PR #${capture.number} became ${recheck.state !== "OPEN" ? recheck.state : "a draft"} during publication; nothing was posted.`,
    );
  }
  if (recheck.head?.sha !== currentHead) {
    throw new PublishError(
      `PR #${capture.number}'s head moved during publication (${currentHead.slice(0, 7)} -> ${String(recheck.head?.sha).slice(0, 7)}); nothing was posted. Re-run the review.`,
    );
  }

  const payload = JSON.stringify({
    body: publication.body,
    event: "COMMENT",
    commit_id: currentHead,
    comments: publication.inline,
  });
  const post = await runGh(["api", "-X", "POST", prPath + "/reviews", "--input", "-"], {
    cwd,
    timeoutMs: DEFAULT_GH_TIMEOUT_MS,
    stdin: payload,
  });
  const base = { inlineCount: publication.inline.length, notedCount: publication.notedCount, stale };
  if (post.code === 0) {
    let created = {};
    try {
      created = JSON.parse(post.stdout);
    } catch {
      // The POST succeeded but the response body is unreadable — reconcile
      // below treats this exactly like an uncertain write.
      created = {};
    }
    if (typeof created.html_url === "string") {
      return { status: "published", reviewUrl: created.html_url, ...base };
    }
  } else {
    const status = httpStatusOf(post.stderr);
    // A 4xx is a definite refusal; a 5xx or a timeout may have gone through.
    if (status !== undefined && status.startsWith("4")) {
      throw new PublishError(`GitHub refused the review POST (HTTP ${status}): ${firstLine(post.stderr)}. Nothing further was attempted.`);
    }
  }

  // Uncertain write: reconcile by scanning existing reviews for the marker —
  // a posted review carries it; absence is treated as not-posted (fail-closed).
  const afterReviews = await ghListOrThrow(runGh, cwd, prPath + "/reviews", {
    pageSize: REVIEWS_PAGE_SIZE,
    maxPages: MAX_REVIEW_PAGES,
    doingWhat: "reconciling an uncertain review POST",
  });
  const landed = afterReviews.find((r) => typeof r.body === "string" && r.body.includes(marker));
  if (landed !== undefined) {
    return { status: "published", reviewUrl: landed.html_url ?? null, ...base, reconciled: true };
  }
  throw new PublishError(
    `the review POST did not land (uncertain response: ${post.code === 0 ? "unparseable response body" : firstLine(post.stderr) || "no output"}) and no review carrying the idempotency marker exists; failing closed — re-run publication if the PR is still open.`,
  );
}

// Chat rendering of a publication outcome. Pure text; the review URL is
// GitHub's own (from the API response), never model text.
export function renderPublishResult(capture, outcome) {
  const head = `Publication (${capture.repo} #${capture.number}):`;
  if (outcome.status === "skipped") {
    return `${head} skipped — ${outcome.reason}`;
  }
  if (outcome.status === "refused") {
    return `${head} refused — ${outcome.reason}`;
  }
  if (outcome.status === "already-published") {
    return [
      `${head} already published for this head (idempotency marker found) — no second POST was made.`,
      outcome.reviewUrl ? `Existing review: ${outcome.reviewUrl}` : "Existing review: (URL unavailable)",
    ].join("\n");
  }
  const lines = [
    `${head} posted one COMMENT review with ${outcome.inlineCount} inline comment${outcome.inlineCount === 1 ? "" : "s"} and ${outcome.notedCount} note${outcome.notedCount === 1 ? "" : "s"} in the body.`,
  ];
  if (outcome.stale) {
    lines.push("The head had moved since capture — the comment is body-only and names both commits.");
  }
  if (outcome.reconciled === true) {
    lines.push("The POST's response was uncertain; the published state was reconciled by finding the idempotency marker on an existing review.");
  }
  lines.push(outcome.reviewUrl ? `Review: ${outcome.reviewUrl}` : "Review: (URL unavailable)");
  return lines.join("\n");
}
