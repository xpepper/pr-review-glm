// Extension entry: registers the /z-pr-review and /z-pr-review-config commands.
// I4 scope: status/help, read-only PR capture (--capture-only), configuration,
// and tiered concurrent reviews — a mode topology of light/medium/heavy lanes
// over the captured diff, each an owned Copilot SDK child runtime under
// attempt/batch/total budgets with one fallback attempt per lane. The session
// LLM never orchestrates anything here (spec: "Architecture A"); every
// handler is plain code and the model runs only inside the lane children.
import { joinSession } from "@github/copilot-sdk/extension";
import { readPluginVersion } from "./version.mjs";
import { CaptureError, capturePullRequest } from "./capture.mjs";
import { ConfigError, ConfigStore } from "./config.mjs";
import { runLaneBatch } from "./batch.mjs";
import { drainUnconfirmedStops } from "./lane.mjs";
import { describeLanes } from "./topologies.mjs";
import { resolveMode } from "./roles.mjs";
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

// Full review (I4): capture, then the mode's topology of tiered lanes run
// concurrently under the config budgets, one fallback attempt per lane. The
// mode comes from the flag or config defaultMode; flags for later increments
// are rejected up front with a pointer, never silently ignored. Publication
// cannot run before I7, so --no-comment is the only posture that exists today.
async function runReview(parsed) {
  const { flags, number } = parsed;
  const unimplemented = flags.all
    ? ["--all", "finding selection arrives with increment I6"]
    : flags.comment === true
      ? ["--comment", "COMMENT publication arrives with increment I7"]
      : null;
  if (unimplemented !== null) {
    throw new Error(`"${unimplemented[0]}" is ${unimplemented[1]}.`);
  }
  const controller = new AbortController();
  const review = { controller, done: Promise.resolve() };
  activeReviews.add(review);
  try {
    await store.load();
    const config = store.get();
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
      onLaneDone: async (lane, result) => {
        const tail = result.status === "complete"
          ? `complete — ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}`
          : `FAILED (${result.reason})`;
        await session.log(`Lane ${lane.id} (${lane.tier}): ${tail}`);
      },
    });
    review.done = batchPromise;
    const batch = await batchPromise;
    const decorated = {
      ...batch,
      lanes: batch.lanes.map((result) => ({
        ...result,
        modelLabel: modelLabelFor(config, result),
      })),
    };
    await session.log(renderReview(outcome.summary, decorated));
  } catch (error) {
    if (error instanceof CaptureError) {
      await session.log(`Capture refused — nothing was written: ${error.message}`, { level: "error" });
      return;
    }
    throw error;
  } finally {
    activeReviews.delete(review);
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
