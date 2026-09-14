// Extension entry: registers the /z-pr-review and /z-pr-review-config commands.
// I4 scope: status/help, read-only PR capture (--capture-only), configuration,
// and tiered concurrent reviews — a mode topology of light/medium/heavy lanes
// over the captured diff, each an owned Copilot SDK child runtime under
// attempt/batch/total budgets with one fallback attempt per lane. The session
// LLM never orchestrates anything here (spec: "Architecture A"); every
// handler is plain code and the model runs only inside the lane children.
import { joinSession } from "@github/copilot-sdk/extension";
import { rm } from "node:fs/promises";
import { readPluginVersion } from "./version.mjs";
import { CaptureError, capturePullRequest } from "./capture.mjs";
import { ConfigError, ConfigStore } from "./config.mjs";
import { runLaneBatch, transportReadAllowanceMs } from "./batch.mjs";
import { assembleReview } from "./adjudicate.mjs";
import { buildFileBackedTransport, describeTransport, TransportError } from "./transport.mjs";
import { drainUnconfirmedStops } from "./lane.mjs";
import { publishReview, PublishError, renderPublishResult } from "./publish.mjs";
import { describeLanes } from "./topologies.mjs";
import { resolveMode } from "./roles.mjs";
import {
  defaultSelection,
  publicationTarget,
  renderInspect,
  renderSelectResult,
  selectionFromFlag,
  selectionFromSpec,
} from "./select.mjs";
import {
  parseConfigArgs,
  parseReviewArgs,
  renderCapture,
  renderConfigHelp,
  renderConfigShow,
  renderHelp,
  renderReview,
  renderStatus,
} from "./commands.mjs";

const store = new ConfigStore();
// Last successful capture in this session; /z-pr-review status reports it and
// later increments (publication) will check against its frozen binding.
let lastCapture = null;
// I6: the retained settled result — the last completed review's assembled
// findings plus the selection over them. In-session only (cross-session
// persistence is out of scope for v1); inspect renders it with no model calls
// and no GitHub access.
let retainedReview = null;

const session = await joinSession({
  commands: [
    {
      name: "z-pr-review",
      description: "PR review via concurrent tiered reviewer lanes over the captured diff; status and help",
      handler: async ({ args }) => {
        const parsed = parseReviewArgs(args);
        if (parsed.kind === "error") {
          throw new Error(parsed.message);
        }
        if (parsed.kind === "status") {
          await session.log(renderStatus(lastCapture, readPluginVersion()));
          return;
        }
        if (parsed.kind === "help") {
          await session.log(renderHelp());
          return;
        }
        if (parsed.kind === "inspect") {
          await session.log(
            retainedReview === null
              ? "No retained review in this session — run /z-pr-review <PR number> first. Inspect needs no model calls and no GitHub access."
              : renderInspect(retainedReview, lastCapture),
          );
          return;
        }
        if (parsed.kind === "select") {
          await runSelect(parsed);
          return;
        }
        // parsed.kind === "review"
        if (parsed.flags.captureOnly) {
          await runCapture(parsed);
          return;
        }
        await runReview(parsed);
      },
    },
    {
      name: "z-pr-review-config",
      description: "Inspect or update z-pr-review configuration (show | key=value | unset)",
      handler: async ({ args }) => {
        const parsed = parseConfigArgs(args);
        if (parsed.kind === "error") {
          throw new Error(parsed.message);
        }
        if (parsed.kind === "help") {
          await session.log(renderConfigHelp(store));
          return;
        }
        try {
          await store.load();
          if (parsed.kind === "set") {
            await store.set(parsed.entries);
          } else if (parsed.kind === "unset") {
            await store.unset(parsed.keys);
          }
        } catch (error) {
          await session.log(describeConfigError(error), { level: "error" });
          return;
        }
        await session.log(renderConfigShow(store));
      },
    },
  ],
});

async function runCapture(parsed) {
  try {
    const outcome = await capturePullRequest({
      number: parsed.number,
      includeDrafts: parsed.flags.includeDrafts,
      includeClosed: parsed.flags.includeClosed,
    });
    if (outcome.status === "skipped") {
      await session.log(outcome.message);
      return;
    }
    lastCapture = outcome.summary;
    await session.log(renderCapture(outcome.summary));
  } catch (error) {
    if (error instanceof CaptureError) {
      await session.log(`Capture refused — nothing was written: ${error.message}`, { level: "error" });
      return;
    }
    throw error;
  }
}

// I6: settle (or re-settle) the selection over the retained review. Pure code
// over the in-session state: no model calls, no GitHub access; a spec naming
// findings that do not exist is refused with a precise reason.
async function runSelect(parsed) {
  if (retainedReview === null) {
    await session.log(
      "No retained review in this session — run /z-pr-review <PR number> first. Nothing was selected.",
      { level: "error" },
    );
    return;
  }
  const selection = selectionFromSpec(parsed.spec, retainedReview.review.findings);
  if (selection.kind === "error") {
    await session.log(`Selection not changed: ${selection.message}`, { level: "error" });
    return;
  }
  retainedReview.selection = selection;
  await session.log(renderSelectResult(retainedReview.capture, selection));
}

// Full review (I5): capture, the mode's topology of tiered lanes under the
// config budgets, then host-side assembly — candidate validation against the
// captured diff, one isolated adjudicator call, dedup, and the per-mode
// findings policy, all code-owned. The mode comes from the flag or config
// defaultMode; flags for later increments are rejected up front with a pointer,
// never silently ignored. I6: the assembled review is retained in-session with
// a selection over its findings (default: all; --all settles it up front).
// I7: when publication is authorized (--comment, or config autoPostReviews
// without an explicit --no-comment), the settled selection posts as ONE gated
// COMMENT review after the report renders. Authority is captured here, before
// capture/lanes run, and is code-owned end to end.
async function runReview(parsed) {
  const { flags, number } = parsed;
  const controller = new AbortController();
  const review = { controller, done: Promise.resolve() };
  activeReviews.add(review);
  const reviewStartedAt = Date.now();
  // Declared ABOVE the try (not at first use): the finally below removes the
  // transport directory on EVERY exit path, and a `let` declared mid-try is
  // still in its temporal dead zone when an early exit (skipped capture, a
  // CaptureError) reaches that finally — the ReferenceError would REPLACE the
  // review's real outcome (caught live by smoke-i3, 2026-09-14).
  let transport = null;
  try {
    await store.load();
    const config = store.get();
    // Publication authority (I7): --comment or --no-comment are explicit;
    // absent a flag, config autoPostReviews decides. Captured before lanes
    // start so no later state can grant a write the invocation didn't ask for.
    const publishAuthority =
      flags.comment === true
        ? "--comment"
        : flags.comment === false
          ? null
          : config.autoPostReviews === true
            ? "autoPostReviews"
            : null;
    const mode = flags.mode ?? config.defaultMode;
    const outcome = await capturePullRequest({
      number,
      includeDrafts: flags.includeDrafts,
      includeClosed: flags.includeClosed,
    });
    if (outcome.status === "skipped") {
      await session.log(outcome.message);
      return;
    }
    lastCapture = outcome.summary;
    await session.log(renderCapture(outcome.summary));
    // I8: at ≥200 KB the diff stops riding in every lane prompt — the frozen
    // capture is sliced into per-file sections on disk and lanes get a
    // manifest with required reads (completeness enforced from tool events).
    // A transport that cannot be built fails the review closed: falling back
    // to an embedded multi-hundred-KB prompt is the condition this exists to
    // prevent, never a silent degradation.
    try {
      transport = await buildFileBackedTransport({
        envelope: outcome.envelope,
        // The review's cancellation and its total budget bound the build too
        // (dogfood round-3 P2): a pathological multi-thousand-file transport
        // is all fs work, but a cancelled or expired review never waits it out.
        signal: controller.signal,
        deadlineAt: reviewStartedAt + config.deadlines.totalMs,
      });
    } catch (error) {
      if (error instanceof TransportError) {
        await session.log(`Review refused — ${error.message}`, { level: "error" });
        return;
      }
      throw error;
    }
    if (transport.mode === "file-backed") {
      await session.log(`Large diff (≥ ${transport.thresholdBytes.toLocaleString("en-US")} bytes): ${describeTransport(transport)}.`);
    }
    // C1: the mode resolves through config — a custom/overridden mode in
    // config.modes composes built-in lanes and custom roles into one lane
    // list that runs through the unchanged budgets, shaping, and gates.
    const lanes = resolveMode(mode, config);
    await session.log(`Dispatching mode ${mode}: ${describeLanes(lanes)}.`);
    const batchPromise = runLaneBatch({
      mode,
      lanes,
      envelope: outcome.envelope,
      config,
      repoRoot: process.cwd(),
      signal: controller.signal,
      transport: transport.mode === "file-backed" ? transport : null,
      onLaneDone: async (lane, result) => {
        const tail = result.status === "complete"
          ? `complete — ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}`
          : `FAILED (${result.reason})`;
        await session.log(`Lane ${lane.id} (${lane.tier}): ${tail}`);
      },
    });
    review.done = batchPromise;
    const batch = await batchPromise;
    // I5: adjudication runs inside the total hard cap — its deadline is
    // deadlines.adjudicationMs clipped to whatever of the total budget
    // remains at assembly time.
    await session.log("Adjudicating validated candidates (heavy tier)…");
    const assembled = await assembleReview({
      batch,
      mode,
      envelope: outcome.envelope,
      config,
      repoRoot: process.cwd(),
      // I5: adjudication runs inside the total hard cap — its deadline is
      // deadlines.adjudicationMs clipped to whatever of the total budget
      // remains at assembly time. I8 folds 5+6: under file-backed transport
      // BOTH the adjudication window and the total clip widen by the SAME
      // read allowance the batch got — the adjudicator reads transport files
      // too (fold 6: it died at 54s of the 60s cap on this PR's 27-file
      // manifest), and a batch that spent its allowance otherwise left
      // adjudication nothing (a degraded review from budget accounting, not
      // from adjudication itself).
      adjudicationDeadlineAt: Math.min(
        Date.now() + config.deadlines.adjudicationMs + transportReadAllowanceMs(transport),
        reviewStartedAt + config.deadlines.totalMs + transportReadAllowanceMs(transport),
      ),
      signal: controller.signal,
      transport: transport.mode === "file-backed" ? transport : null,
    });
    const decorated = {
      ...assembled,
      transport: transport.mode === "file-backed" ? transport : null,
      lanes: assembled.lanes.map((result) => ({
        ...result,
        modelLabel: modelLabelFor(config, result),
      })),
    };
    await session.log(renderReview(outcome.summary, decorated));
    // The outgoing retained result for THIS PR, if any — captured before the
    // replacement below so an authorized publication can honor its settled
    // selection (publicationTarget) instead of silently discarding it.
    const outgoing =
      retainedReview !== null &&
      retainedReview.capture.repo === outcome.summary.repo &&
      retainedReview.capture.number === outcome.summary.number
        ? retainedReview
        : null;
    // One review is one selection surface (I6): replacing the retained review
    // resets its selection. When the outgoing selection was settled explicitly
    // via `select` — especially `select none`, a publication posture — say so
    // instead of silently starting from the default all.
    if (outgoing !== null && outgoing.selection.via === "select") {
      await session.log(
        `Replacing the retained review for PR #${outcome.summary.number}: its select-settled selection (${outgoing.selection.count} of ${outgoing.selection.total} findings) no longer covers the new findings — the new review starts from the default all-selection. Re-settle with /z-pr-review select after this run.`,
      );
    }
    // I6: retain the settled-in-progress result. The default selection keeps
    // every validated finding; --all settles that default at review time.
    // Even a partial/degraded review is retained — its findings were still
    // host-validated, and its status travels with the retained result.
    retainedReview = {
      capture: outcome.summary,
      review: decorated,
      selection: flags.all
        ? selectionFromFlag(decorated.findings)
        : defaultSelection(decorated.findings),
      retainedAt: new Date().toISOString(),
    };
    if (flags.all) {
      await session.log(renderSelectResult(outcome.summary, retainedReview.selection));
    }
    if (publishAuthority !== null) {
      // A settled selection is never silently discarded by a re-review: when
      // the outgoing retained result for this PR carries a select-settled
      // selection (and this run did not explicitly settle --all), publication
      // posts THAT settled result — publication re-validates it against the
      // live PR and degrades to body-only if the head or base moved since.
      const target = publicationTarget(outgoing, retainedReview, flags.all === true);
      if (target === outgoing) {
        await session.log(
          `Publication uses the select-settled selection for PR #${outcome.summary.number} (${outgoing.selection.count} of ${outgoing.selection.total} findings from the retained review at head ${outgoing.capture.headOid.slice(0, 7)}) — not this run's default. Pass --all to publish the new review's findings instead.`,
        );
      }
      // The review's controller rides along: a cancelled review (session end)
      // must not reach the POST even if it reached publication.
      await runPublication(target, controller.signal);
    }
  } catch (error) {
    if (error instanceof CaptureError) {
      await session.log(`Capture refused — nothing was written: ${error.message}`, { level: "error" });
      return;
    }
    throw error;
  } finally {
    // The transport directory (large diffs only) outlives its usefulness the
    // moment the review settles — anchor validation at publication reads the
    // live PR files API, never the transport files, and the retained result
    // references only the capture path (which is I2-era deliberate retention:
    // inspect names it). In the finally (dogfood round-2 P2): a review that
    // throws or is cancelled mid-flight must not leak it either. Best-effort
    // removal with disclosure (transport dirs are diff content on disk —
    // never kept).
    if (transport?.mode === "file-backed") {
      try {
        await rm(transport.dir, { recursive: true, force: true });
      } catch (error) {
        await session.log(
          `Note: could not remove the file-backed transport directory ${transport.dir} (${String(error?.message ?? error).slice(0, 120)}); remove it manually.`,
        );
      }
    }
    activeReviews.delete(review);
  }
}

// I7: publish the retained review's settled selection as one gated COMMENT
// review (the invocation's authority was already settled in runReview — this
// path only runs when publication was authorized). The review's abort signal
// is threaded through so a cancelled review cannot write. Writes to the same
// repo#PR are serialized in-process (the spec's per-target write
// serialization) — a second publication waits for the first to settle instead
// of racing its gates and marker scan. A settled lock deletes itself when it
// is still the tail entry, so the map holds only in-flight publications, not
// one retained promise per PR ever seen.
const publicationLocks = new Map();

async function runPublication(retained, signal) {
  const { capture } = retained;
  const key = `${capture.repo}#${capture.number}`;
  const prior = publicationLocks.get(key) ?? Promise.resolve();
  const run = prior.then(
    () => publishReview({ retained, signal }),
    () => publishReview({ retained, signal }),
  );
  const tail = run.catch(() => {});
  publicationLocks.set(key, tail);
  tail.then(() => {
    if (publicationLocks.get(key) === tail) publicationLocks.delete(key);
  });
  try {
    const outcome = await run;
    await session.log(renderPublishResult(capture, outcome));
  } catch (error) {
    if (error instanceof PublishError) {
      await session.log(`Publication refused — nothing was posted: ${error.message}`, { level: "error" });
      return;
    }
    throw error;
  }
}

// readPluginVersion lives in ./version.mjs (unit-tested there).

function modelLabelFor(config, laneResult) {
  // The label names the model that actually ran for this lane — the most
  // recent attempt's model. For a completed lane that is the completing
  // attempt; for a failed lane it is whichever model the lane was last run on
  // (the fallback when it got that far), never a misreport of the tier
  // default. Lanes without attempt records (none today) fall back to the
  // tier's configured model.
  const last = laneResult.attempts?.at(-1);
  if (last !== undefined) return last.model ?? "session default model";
  return config.tiers[laneResult.tier].model ?? "session default model";
}

function describeConfigError(error) {
  if (error instanceof ConfigError) {
    return [
      "Configuration not changed. The whole file is validated as a unit:",
      ...error.problems.map((problem) => `- ${problem}`),
      "Run /z-pr-review-config show to see the active (last valid) configuration.",
    ].join("\n");
  }
  return `Configuration not changed: ${String(error)}`;
}

// Parent cancellation: the SDK hands command handlers no abort signal and no
// disconnect event — the host's only cancellation notices are process-level
// (stdin end/error, SIGTERM, SIGINT, ~5s before a SIGKILL). Each review owns
// an AbortController passed into its lane batch, and those signals are routed
// through it here, so concurrent child runtimes are aborted and stopped
// instead of orphaned by a raw process.exit mid-batch.
const activeReviews = new Set();

async function shutdown() {
  for (const review of activeReviews) {
    review.controller.abort(new Error("parent session ended"));
  }
  await Promise.race([
    Promise.allSettled([...activeReviews].map((review) => review.done)),
    new Promise((resolve) => setTimeout(resolve, 2_500)),
  ]);
  await drainUnconfirmedStops(Date.now() + 1_500);
  process.exit(0);
}

// The parent CLI owns this process; when its stdin closes we must not linger.
process.stdin.once("end", shutdown);
process.stdin.once("error", shutdown);
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
