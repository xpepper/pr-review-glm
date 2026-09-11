// Extension entry: registers the /z-pr-review and /z-pr-review-config commands.
// I3 scope: status/help, read-only PR capture (--capture-only), configuration,
// and the first real review — one heavy lane over the captured diff in an
// owned Copilot SDK child runtime, findings rendered in-chat. The session LLM
// never orchestrates anything here (spec: "Architecture A"); every handler is
// plain code and the model runs only inside the lane child.
import { joinSession } from "@github/copilot-sdk/extension";
import { CaptureError, capturePullRequest } from "./capture.mjs";
import { ConfigError, ConfigStore } from "./config.mjs";
import { runHeavyLane } from "./lane.mjs";
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
      description: "PR review via a heavy reviewer lane over the captured diff; status and help",
      handler: async ({ args }) => {
        const parsed = parseReviewArgs(args);
        if (parsed.kind === "error") {
          throw new Error(parsed.message);
        }
        if (parsed.kind === "status") {
          await session.log(renderStatus(lastCapture));
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

// Full review (I3): capture, then one heavy lane over the captured diff in an
// owned child runtime. Flags for later increments are rejected up front with a
// pointer, never silently ignored; publication cannot run before I7, so
// --no-comment is the only posture that exists today.
async function runReview(parsed) {
  const { flags, number } = parsed;
  const unimplemented = flags.mode !== null
    ? ["--" + flags.mode, "mode topologies arrive with increment I4"]
    : flags.all
      ? ["--all", "finding selection arrives with increment I6"]
      : flags.comment === true
        ? ["--comment", "COMMENT publication arrives with increment I7"]
        : null;
  if (unimplemented !== null) {
    throw new Error(`"${unimplemented[0]}" is ${unimplemented[1]}.`);
  }
  try {
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
    await store.load();
    const lane = await runHeavyLane({
      envelope: outcome.envelope,
      config: store.get(),
      repoRoot: process.cwd(),
    });
    const modelLabel = store.get().tiers.heavy.model ?? "session default model";
    await session.log(renderReview(outcome.summary, { ...lane, modelLabel }));
  } catch (error) {
    if (error instanceof CaptureError) {
      await session.log(`Capture refused — nothing was written: ${error.message}`, { level: "error" });
      return;
    }
    throw error;
  }
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

// The parent CLI owns this process; when its stdin closes we must not linger.
process.stdin.once("end", () => process.exit(0));
process.stdin.once("error", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(0));
