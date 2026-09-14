// I7: gated COMMENT publication — the write side of the review pipeline.
// Authority is code-owned only (spec: "Publication gates"): the invocation
// flag --comment or config autoPostReviews, both captured before lanes start
// (extension.mjs); model text never selects the event, commit, repo, or
// anchors. Publication posts ONE COMMENT review whose inline comments are the
// first ≤50 selected findings whose anchors re-validate against the live
// `pulls/N/files` hunks; everything else goes to body notes. Draft, closed,
// and self-author PRs are refused — the self-author refusal alone can be
// explicitly overridden (S46, issue #46) by the deliberate
// --comment --self-review invocation pairing, which extension.mjs translates
// into allowSelfReview here and which the posted body then discloses. A moved
// head OR base (since capture) degrades to a body-only comment naming the
// frozen commits and bases; an idempotency marker makes re-runs skip and
// lets an uncertain write response be reconciled. The head AND base are
// re-pinned immediately before the POST, and a cancelled review (its abort
// signal) never writes. No selected findings means no POST at all.
import { spawn } from "node:child_process";

export const MAX_INLINE_ANCHORS = 50;
// S46: the static disclosure line an explicitly authorized self-review
// publication carries in the posted COMMENT body. Code-owned text, the same
// authority class as the idempotency marker — never model-influenced — so a
// PR reader can tell the author published the review to their own PR on
// purpose.
export const SELF_REVIEW_DISCLOSURE =
  "Self-review disclosure: this review was published by the PR's own author, explicitly authorized at invocation time by the --self-review flag.";
// GitHub's documented review-body cap is 65,536 characters; stop well short so
// composition can never trip the API's own limit instead of our gate.
export const MAX_BODY_CHARS = 60_000;
// Same posture per inline comment: the API's own per-comment cap is larger,
// but a single oversized finding must fail our gate, not the POST.
export const MAX_COMMENT_CHARS = 60_000;
const DEFAULT_GH_TIMEOUT_MS = 30_000;
const FILES_PAGE_SIZE = 100;
const MAX_FILE_PAGES = 5; // 500 files; beyond that the anchor map fails closed
const REVIEWS_PAGE_SIZE = 100;
const MAX_REVIEW_PAGES = 10; // the marker scan reads every review page
// I8: how many times (and how far apart) the uncertain-write reconciliation
// rescans a lagging review listing before concluding the POST did not land.
const RECONCILE_SCANS = 3;
const RECONCILE_DELAY_MS = 2_000;

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
// code/stderr/timedOut so the caller stays fail-closed. A `signal` (dogfood
// round-2 P2) SIGTERMs the child mid-flight — the cancelled caller must not
// wait out the full 30s request timeout while holding the per-PR lock; a
// killed POST is an uncertain write the marker reconciliation already owns.
export function defaultRunGh(args, { cwd, timeoutMs, stdin, signal = null }) {
  const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn("gh", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    let timer = null;
    let killTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    // Byte counters, not string lengths: `length` counts UTF-16 code units, so
    // multibyte output would silently under-report against a byte budget.
    // Once the budget is tripped nothing more is retained — SIGKILL is async,
    // and buffered data events keep firing until close.
    const capped = (stream, chunk) => {
      if (overflowed) return;
      if (stream === "out") stdout += chunk;
      else stderr += chunk;
      const total = (stream === "out" ? (stdoutBytes += Buffer.byteLength(chunk)) : (stderrBytes += Buffer.byteLength(chunk)));
      if (total > MAX_OUTPUT_BYTES && !overflowed) {
        overflowed = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => capped("out", chunk));
    child.stderr.on("data", (chunk) => capped("err", chunk));
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
// the GitHub payload — C0, DEL, AND the C1 range (U+0080–U+009F, whose U+009B
// is an 8-bit CSI terminals may interpret as ANSI) — and `<!--` is defused so
// finding text can never forge (or shadow) the idempotency marker.
function sanitize(text) {
  return String(text ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g, "")
    .replaceAll("<!--", "<! --");
}

export function idempotencyMarker(repo, number, headOid, baseOid) {
  return `<!-- z-pr-review ${repo}#${number}@${headOid}+${baseOid} -->`;
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
// non-complete reviews, the S46 self-review authorization disclosure, and the
// idempotency marker. A stale review (head OR base moved since capture)
// disables inline comments entirely — the body names both commits and both
// bases (spec's stale rule, extended to the base).
export function buildPublication({ capture, review, selected, anchorMap, currentHead, currentBase, stale, selfReview = false }) {
  const inline = [];
  const noted = [];
  for (const finding of selected) {
    if (!stale && inline.length < MAX_INLINE_ANCHORS && anchorable(finding, anchorMap)) {
      const body = commentBody(finding);
      // Per-comment cap at composition time: an oversized inline body must
      // fail our gate here, not after the whole payload was built.
      if (body.length > MAX_COMMENT_CHARS) {
        throw new PublishError(
          `an inline comment body is ${body.length} characters (cap ${MAX_COMMENT_CHARS}); failing closed — nothing was posted.`,
        );
      }
      // `side: "RIGHT"` is required by the reviews API for a `line` anchor and
      // matches the anchor map, which is built from new-side hunk ranges only.
      inline.push({ path: finding.file, line: finding.line, side: "RIGHT", body });
    } else {
      noted.push(finding);
    }
  }
  const lines = [`## z-pr-review review of PR #${capture.number} (${capture.repo})`];
  lines.push(
    `${selected.length} finding${selected.length === 1 ? "" : "s"} selected for publication — all host-validated against the diff captured at review time.`,
  );
  // S46: only an actually-authorized self-review publication (the viewer
  // authored the PR AND allowSelfReview was passed) discloses; an ordinary
  // publication of someone else's PR never claims self-review authorization.
  if (selfReview === true) {
    lines.push("", SELF_REVIEW_DISCLOSURE);
  }
  if (stale) {
    lines.push(
      "",
      `This review ran against head \`${capture.headOid}\` on base \`${capture.baseOid}\`; the PR is now at head \`${currentHead}\` on base \`${currentBase}\` — the diff has moved since capture, so findings are attached here rather than inline, and the frozen commits are named in this note.`,
    );
  }
  if (noted.length > 0) {
    lines.push("", "### Other notes");
    noted.forEach((finding, index) => {
      // The filename is model-influenced text like title/detail (host-validated
      // against the diff, but still rendered): sanitize it too, or a path
      // carrying marker-shaped text could forge the idempotency marker.
      const location = finding.file ? ` — ${sanitize(finding.file)}${typeof finding.line === "number" ? `:${finding.line}` : ""}` : "";
      lines.push(`${index + 1}. **[${finding.severity}] ${sanitize(finding.title)}**${location}`);
      if (finding.detail) lines.push(`   ${sanitize(finding.detail)}`);
      // Body cap at composition time: bail as soon as the assembled body trips
      // the cap instead of materializing the complete payload first. The
      // running check bounds the work — once the cap trips nothing more is
      // composed.
      if (lines.join("\n").length > MAX_BODY_CHARS) {
        throw new PublishError(
          `composed review body exceeds the cap (${MAX_BODY_CHARS} characters); failing closed — nothing was posted.`,
        );
      }
    });
  }
  if (review.status !== "complete") {
    const coverage = review.lanes.filter((lane) => lane.status === "complete").length;
    lines.push(
      "",
      `Coverage: ${coverage}/${review.lanes.length} lanes completed — ${review.status}${review.reason !== undefined ? ` (${review.reason})` : ""}. This is an incomplete review, never a clean one.`,
    );
  }
  // The marker names the CAPTURE binding (head+base), never the live head:
  // a stale publication (captured H1, posted after the PR reached H2) must
  // not occupy H2's slot and suppress a distinct fresh review at H2 — and a
  // base-only move re-diffs the PR just as a head move does, so the base
  // belongs in the identity too. Re-running the same publication still finds
  // its own marker and skips.
  lines.push("", idempotencyMarker(capture.repo, capture.number, capture.headOid, capture.baseOid));
  const body = lines.join("\n");
  // Final belt over the incremental checks above (the marker and coverage
  // lines are appended after the notes loop).
  if (body.length > MAX_BODY_CHARS) {
    throw new PublishError(
      `composed review body exceeds the cap (${MAX_BODY_CHARS} characters); failing closed — nothing was posted.`,
    );
  }
  return { body, inline, notedCount: noted.length };
}

async function ghJson(runGh, cwd, args, doingWhat, { stdin, signal } = {}) {
  // A cancelled review stops asking gh for anything: every paginated scan in
  // this file funnels through here, so this check is what keeps an aborted
  // publication from holding the per-target lock through more pages (the I7
  // review P2 — the signal existed but never reached the gh boundary).
  if (signal?.aborted) {
    throw new PublishError(`the review was cancelled while ${doingWhat}; nothing more was attempted.`);
  }
  const result = await runGh(args, { cwd, timeoutMs: DEFAULT_GH_TIMEOUT_MS, ...(stdin === undefined ? {} : { stdin }), ...(signal ? { signal } : {}) });
  // The abort may have landed DURING the call (an in-flight request the
  // signal killed, or a fake runner in tests): treat it as cancelled before
  // interpreting the mangled result — the reconciliation/marker machinery
  // owns any uncertainty a killed POST left behind, on a later run.
  if (signal?.aborted) {
    throw new PublishError(`the review was cancelled while ${doingWhat}; nothing more was attempted.`);
  }
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
// A list of EXACTLY maxPages*pageSize entries is legitimate: every allowed
// page being full is indistinguishable from an over-cap list without one
// probe entry beyond the cap. The signal is re-checked before every page —
// a cancelled review never pages further.
async function ghListOrThrow(runGh, cwd, path, { pageSize, maxPages, doingWhat, signal }) {
  const all = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const args = ["api", `${path}?per_page=${pageSize}&page=${page}`];
    const batch = await ghJsonOrThrow(runGh, cwd, args, doingWhat, { signal });
    if (!Array.isArray(batch)) {
      throw new PublishError(`gh returned a non-array while ${doingWhat}; failing closed — nothing was posted.`);
    }
    all.push(...batch);
    if (batch.length < pageSize) return all;
  }
  const probe = await ghJsonOrThrow(
    runGh,
    cwd,
    ["api", `${path}?per_page=1&page=${maxPages * pageSize + 1}`],
    doingWhat,
    { signal },
  );
  if (Array.isArray(probe) && probe.length === 0) return all;
  throw new PublishError(`${doingWhat}: more than ${maxPages * pageSize} entries; failing closed — nothing was posted.`);
}

function httpStatusOf(stderr) {
  return /\(HTTP (\d+)\)/.exec(stderr)?.[1];
}

// REST reports lifecycle state lowercase ("open"/"closed"); the gate is
// case-normalized so a live open PR can never be refused on spelling.
const isOpenState = (pr) => String(pr.state ?? "").toUpperCase() === "OPEN";

// Publishes the retained review's selected findings as ONE gated COMMENT
// review. `signal` is the owning review's AbortController signal: a cancelled
// review must not write — checked before any gh call and again immediately
// before the POST (an abort landing during the POST itself is reconciled by
// the marker scan on any later run; that residual window is accepted).
// `allowSelfReview` (S46) is the explicit self-publication authorization; it
// is plain code authority threaded from the parse-validated
// --comment --self-review pairing (extension.mjs) and defaults to false, so
// the self-author gate stays fail-closed for every other caller shape.
// Outcomes (never a silent partial write):
//   { status: "skipped", reason }            — no selected findings; no POST
//   { status: "refused", reason }            — a gate declined the PR; no POST
//   { status: "already-published", reviewUrl, marker } — idempotency skip
//   { status: "published", reviewUrl, inlineCount, notedCount, stale, selfReview, reconciled }
// Throws PublishError on every fail-closed condition.
export async function publishReview({
  retained,
  signal = null,
  allowSelfReview = false,
  runGh = defaultRunGh,
  cwd = process.cwd(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (signal?.aborted) {
    return { status: "refused", reason: "the review was cancelled before publication; nothing was posted." };
  }
  const { capture, review, selection } = retained;
  const selected = selectedFindings(review.findings, selection);
  if (selected.length === 0) {
    return { status: "skipped", reason: "no findings are selected — nothing to publish." };
  }
  const prPath = `repos/${capture.repo}/pulls/${capture.number}`;

  // Lifecycle, self-author, and head gates read ONE fresh PR fetch; the
  // captured binding names the repo/PR, never a live one. The abort signal
  // rides every gh call from here on (ghJson checks it at the boundary).
  const pr = await ghJsonOrThrow(runGh, cwd, ["api", prPath], `fetching PR #${capture.number} for publication gates`, { signal });
  if (!isOpenState(pr)) {
    return { status: "refused", reason: `PR #${capture.number} is ${pr.state ?? "in an unknown state"}; nothing was posted.` };
  }
  if (pr.draft === true) {
    return { status: "refused", reason: `PR #${capture.number} is a draft; nothing was posted.` };
  }
  const viewer = await ghJsonOrThrow(runGh, cwd, ["api", "user"], "resolving the authenticated gh user", { signal });
  if (typeof viewer?.login !== "string" || viewer.login === "") {
    throw new PublishError(`could not resolve the authenticated gh user; failing closed — nothing was posted.`);
  }
  const prAuthor = typeof pr.user?.login === "string" ? pr.user.login : null;
  if (prAuthor === null) {
    throw new PublishError(`PR #${capture.number} has no author login; the self-review gate cannot run, so failing closed — nothing was posted.`);
  }
  // S46: the self-author gate stays fail-closed by default; the ONLY override
  // is the explicit allowSelfReview authorization, which the parser only ever
  // attaches to a deliberate --comment --self-review invocation (never config
  // autoPostReviews). An authorized self-review is still a self-review: the
  // flag is remembered so the body discloses it and the outcome reports it.
  let selfReview = false;
  if (prAuthor === viewer.login) {
    if (allowSelfReview !== true) {
      return {
        status: "refused",
        reason: `PR #${capture.number} is authored by ${viewer.login} (you); self-review publication is refused. Re-run with --comment --self-review to publish it to your own PR.`,
      };
    }
    selfReview = true;
  }
  const currentHead = pr.head?.sha;
  if (typeof currentHead !== "string" || !/^[0-9a-f]{40}$/.test(currentHead)) {
    throw new PublishError(`PR #${capture.number} has a malformed head sha; failing closed — nothing was posted.`);
  }
  // The base is pinned with the head: the anchor map is derived from this same
  // fetch, and a base that advances without moving the head re-diffs the PR —
  // previously validated RIGHT-side lines may stop being commentable.
  const currentBase = pr.base?.sha;
  if (typeof currentBase !== "string" || !/^[0-9a-f]{40}$/.test(currentBase)) {
    throw new PublishError(`PR #${capture.number} has a malformed base sha; failing closed — nothing was posted.`);
  }
  // Staleness is symmetric in head and base: a moved head re-writes the PR,
  // but so does a base that advanced under an unchanged head — the live diff
  // shifts and the captured diff (the one findings were validated against) no
  // longer describes it. Either way the publication degrades to body-only.
  const staleHead = currentHead !== capture.headOid;
  const staleBase = currentBase !== capture.baseOid;
  const stale = staleHead || staleBase;

  // Idempotency: a review carrying this exact marker already exists → skip.
  // The marker text is deterministic, so any PR participant could paste it
  // into their own review — only the authenticated viewer's reviews can
  // legitimately carry OUR marker. Keyed on the capture binding (head+base):
  // the same key buildPublication embeds in the body.
  const marker = idempotencyMarker(capture.repo, capture.number, capture.headOid, capture.baseOid);
  const carriesMarker = (r) =>
    r.user?.login === viewer.login && typeof r.body === "string" && r.body.includes(marker);
  const existingReviews = await ghListOrThrow(runGh, cwd, prPath + "/reviews", {
    pageSize: REVIEWS_PAGE_SIZE,
    maxPages: MAX_REVIEW_PAGES,
    doingWhat: "scanning existing reviews for the idempotency marker",
    signal,
  });
  const prior = existingReviews.find(carriesMarker);
  if (prior !== undefined) {
    return { status: "already-published", reviewUrl: prior.html_url ?? null, marker };
  }

  // A stale publication never anchors inline, so it must not depend on the
  // changed-file list at all — a >500-file PR still gets its body-only stale
  // comment instead of a pagination failure.
  const files = stale
    ? []
    : await ghListOrThrow(runGh, cwd, prPath + "/files", {
        pageSize: FILES_PAGE_SIZE,
        maxPages: MAX_FILE_PAGES,
        doingWhat: "fetching the PR's changed files for anchor validation",
        signal,
      });
  const publication = buildPublication({
    capture,
    review,
    selected,
    anchorMap: anchorMapFromFiles(files),
    currentHead,
    currentBase,
    stale,
    selfReview,
  });
  // Body and per-comment caps are enforced inside buildPublication at
  // composition time — an oversized payload fails our gate there, before the
  // pre-write re-check and the POST, and is never fully materialized.

  // Final pre-write re-check: gates, files, and body were all composed against
  // the earlier fetch; if the PR closed, turned draft, its head moved, or its
  // base advanced (re-diffing the PR under the validated anchors) in between,
  // posting now would write against a state the gates never cleared.
  const recheck = await ghJsonOrThrow(runGh, cwd, ["api", prPath], "re-checking the PR immediately before posting", { signal });
  if (!isOpenState(recheck) || recheck.draft === true) {
    throw new PublishError(
      `PR #${capture.number} became ${!isOpenState(recheck) ? recheck.state ?? "an unknown state" : "a draft"} during publication; nothing was posted.`,
    );
  }
  if (recheck.head?.sha !== currentHead) {
    throw new PublishError(
      `PR #${capture.number}'s head moved during publication (${currentHead.slice(0, 7)} -> ${String(recheck.head?.sha).slice(0, 7)}); nothing was posted. Re-run the review.`,
    );
  }
  if (recheck.base?.sha !== currentBase) {
    throw new PublishError(
      `PR #${capture.number}'s base moved during publication (${currentBase.slice(0, 7)} -> ${String(recheck.base?.sha).slice(0, 7)}) — the live diff may no longer match the validated anchors; nothing was posted. Re-run the review.`,
    );
  }
  if (signal?.aborted) {
    throw new PublishError(`the review was cancelled during publication; nothing was posted.`);
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
    ...(signal ? { signal } : {}),
  });
  const base = {
    inlineCount: publication.inline.length,
    notedCount: publication.notedCount,
    stale,
    staleHead,
    staleBase,
    selfReview,
  };
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
  // The scan is BOUNDED-RETRIED (I8, the I7 review P2): GitHub's review
  // listing can lag the POST by seconds, so a single scan could fail closed
  // over a landed review — and a fail-closed stop is exactly what prompts a
  // rerun, whose own pre-POST scan hits the same lagging listing and would
  // duplicate the comment. Retrying the scan a few times lets the marker
  // surface so the rerun path never forms. Each scan re-checks the abort
  // signal, and so does the backoff between scans (dogfood round-1 P2: a
  // cancelled review must not sit out the full delay before noticing).
  const backoff = async () => {
    if (!signal) {
      await sleep(RECONCILE_DELAY_MS);
      return;
    }
    if (signal.aborted) {
      throw new PublishError("the review was cancelled while waiting to reconcile an uncertain review POST; nothing more was attempted.");
    }
    const { promise, reject } = Promise.withResolvers();
    const onAbort = () =>
      reject(new PublishError("the review was cancelled while waiting to reconcile an uncertain review POST; nothing more was attempted."));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([sleep(RECONCILE_DELAY_MS), promise]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };
  for (let scan = 1; scan <= RECONCILE_SCANS; scan += 1) {
    const afterReviews = await ghListOrThrow(runGh, cwd, prPath + "/reviews", {
      pageSize: REVIEWS_PAGE_SIZE,
      maxPages: MAX_REVIEW_PAGES,
      doingWhat: `reconciling an uncertain review POST (scan ${scan} of ${RECONCILE_SCANS})`,
      // Deliberately signal-free (dogfood round-3 P2): reconciliation is
      // READ-ONLY — cancellation blocks writes, never reads. An uncertain
      // POST that the abort may itself have killed (defaultRunGh SIGTERMs
      // mid-flight) still gets reconciled NOW, so the outcome tells the
      // truth (published-reconciled) instead of deferring to a rerun. The
      // backoff between scans stays abort-aware: a cancelled review never
      // sits out further delays, and the marker scan on any later run is
      // the backstop either way.
      signal: null,
    });
    const landed = afterReviews.find(carriesMarker);
    if (landed !== undefined) {
      return {
        status: "published",
        reviewUrl: landed.html_url ?? null,
        ...base,
        reconciled: true,
        reconcileScans: scan,
      };
    }
    if (scan < RECONCILE_SCANS) await backoff();
  }
  throw new PublishError(
    `the review POST did not land (uncertain response: ${post.code === 0 ? "unparseable response body" : firstLine(post.stderr) || "no output"}) and no review carrying the idempotency marker appeared within ${RECONCILE_SCANS} reconciliation scans; failing closed — re-run publication if the PR is still open.`,
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
      `${head} already published for this review's capture binding (idempotency marker found) — no second POST was made.`,
      outcome.reviewUrl ? `Existing review: ${outcome.reviewUrl}` : "Existing review: (URL unavailable)",
    ].join("\n");
  }
  const lines = [
    `${head} posted one COMMENT review with ${outcome.inlineCount} inline comment${outcome.inlineCount === 1 ? "" : "s"} and ${outcome.notedCount} note${outcome.notedCount === 1 ? "" : "s"} in the body.`,
  ];
  if (outcome.stale) {
    // Base-only staleness must be reported as what it is — the base advancing
    // under an unchanged head re-diffs the PR just the same, but saying "the
    // head had moved" would be false.
    const moved = outcome.staleHead && outcome.staleBase
      ? "head and base had moved"
      : outcome.staleBase
        ? "base had advanced (head unchanged)"
        : "head had moved";
    lines.push(`The ${moved} since capture — the comment is body-only and names both commits and bases.`);
  }
  if (outcome.selfReview === true) {
    lines.push(
      "Self-review publication: this COMMENT went to a PR you authored — explicitly authorized by --self-review, and disclosed in the posted comment.",
    );
  }
  if (outcome.reconciled === true) {
    lines.push(
      outcome.reconcileScans > 1
        ? `The POST's response was uncertain; the published state was reconciled by finding the idempotency marker on an existing review (review-scan ${outcome.reconcileScans} of ${RECONCILE_SCANS} — the listing lagged the POST).`
        : "The POST's response was uncertain; the published state was reconciled by finding the idempotency marker on an existing review.",
    );
  }
  lines.push(outcome.reviewUrl ? `Review: ${outcome.reviewUrl}` : "Review: (URL unavailable)");
  return lines.join("\n");
}
