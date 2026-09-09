// Extension entry: registers the /pr-review and /pr-review-config commands.
// I1 scope: status/help and configuration only — no PR capture, no lanes, no
// model calls. The session LLM never orchestrates anything here (spec:
// "Architecture A"); every handler is plain code that logs and returns.
import { joinSession } from "@github/copilot-sdk/extension";
import { ConfigError, ConfigStore } from "./config.mjs";
import {
  parseConfigArgs,
  parseReviewArgs,
  renderConfigHelp,
  renderConfigShow,
  renderHelp,
  renderStatus,
} from "./commands.mjs";

const store = new ConfigStore();

const session = await joinSession({
  commands: [
    {
      name: "pr-review",
      description: "Show the pr-review-glm capability boundary (status/help only for now)",
      handler: async ({ args }) => {
        const parsed = parseReviewArgs(args);
        if (parsed.kind === "error") {
          throw new Error(parsed.message);
        }
        await session.log(parsed.kind === "status" ? renderStatus() : renderHelp());
      },
    },
    {
      name: "pr-review-config",
      description: "Inspect or update pr-review-glm configuration (show | key=value | unset)",
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
      "Run /pr-review-config show to see the active (last valid) configuration.",
    ].join("\n");
  }
  return `Configuration not changed: ${String(error)}`;
}

// The parent CLI owns this process; when its stdin closes we must not linger.
process.stdin.once("end", () => process.exit(0));
process.stdin.once("error", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(0));
