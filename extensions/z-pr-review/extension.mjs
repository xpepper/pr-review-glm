// Extension entry: registers the /z-pr-review and /z-pr-review-config commands.
// I2 scope: status/help, read-only PR capture (--capture-only), and
// configuration — no lanes, no model calls. The session LLM never orchestrates
// anything here (spec: "Architecture A"); every handler is plain code.
import { joinSession } from "@github/copilot-sdk/extension";
import { CaptureError, capturePullRequest } from "./capture.mjs";
import { ConfigError, ConfigStore } from "./config.mjs";
import {
  parseConfigArgs,
  parseReviewArgs,
  renderCapture,
  renderConfigHelp,
  renderConfigShow,
  renderHelp,
  renderStatus,
} from "./commands.mjs";

const store = new ConfigStore();
// Last successful capture in this session; /z-pr-review status reports it and
// later increments (lanes, publication) will check against its frozen binding.
let lastCapture = null;

const session = await joinSession({
  commands: [
    {
      name: "z-pr-review",
      description: "Read-only PR capture (--capture-only) plus status and help",
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
        if (!parsed.flags.captureOnly) {
          throw new Error(
            "Reviews are not implemented yet (they arrive with increment I3). " +
              `Today only capture works: /z-pr-review ${parsed.number} --capture-only`,
          );
        }
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
