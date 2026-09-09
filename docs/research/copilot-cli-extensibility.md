# GitHub Copilot CLI extensibility + Agent Plugins protocol — research notes (Sept 2026)

Researched 2026-09-09 for porting pi-pr-review. Official docs preferred; note the CLI ships weekly — re-verify against the changelog before finalizing a design.

## 1. What Copilot CLI is

Standalone `copilot` binary, **GA since 2026-02-25** (open repo github/copilot-cli, ~1.0.83 as of Sept 2026). Old `gh copilot` extension deprecated (Oct 2025); `gh copilot` is now a shim installing the standalone CLI. Install: npm `@github/copilot`, brew, winget, script.

## 2. Extension mechanisms

**a) Custom instructions** — `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md` (`applyTo` glob), `~/.copilot/copilot-instructions.md` + `~/.copilot/instructions/`. Also reads AGENTS.md / CLAUDE.md / GEMINI.md. Files are combined.

**b) Custom slash commands** — markdown prompt files are **NOT** natively supported (open FRs #9, #1113). Slash commands come from: (1) the extension SDK (`joinSession({commands:[...]})`), (2) plugin manifest `commands` field.

**c) MCP servers** — `~/.copilot/mcp-config.json` (user), `.mcp.json` / `.github/mcp.json` (project). `copilot mcp add/list/get/remove`, `/mcp`. GitHub MCP server built in. Tool gating via `--tools`.

**d) Hooks** — `.github/hooks/*.json` (repo, default branch), `~/.copilot/hooks/`. Events: `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse` (exit 2 denies), `postToolUse`, `errorOccurred`, `agentStop`. JSON on stdin.

**e) Headless mode** — `copilot -p "prompt"` (prompt also via stdin) + `--output-format=json` (JSONL). `--allow-tool 'shell(gh pr review)'` / `--deny-tool` / `--allow-all-tools`; `copilot login --with-token` for CI. This is the subprocess-lane enabler (pi's `--mode json -p` analogue).

**f) Extension API (experimental)** — Node ES module at `.github/extensions/<name>/extension.mjs` (project) or `~/.copilot/extensions/...` (user); JSON-RPC over stdio child process. `import { joinSession } from "@github/copilot-sdk/extension"` (bundled with CLI). Registers **custom tools** (name, description, JSON-Schema parameters, handler, defer, skipPermission) and **custom slash commands** (`ctx.args`). Events `session.on("tool.execution_start"|"tool.execution_complete"|"assistant.usage")`; `session.log()`. Community-documented: `session.ui.elicitation()` dialogs, `/extensions manage|reload`, SDKs for Node/Python/Go/.NET. Experimental; plugin packaging of extensions works since ~1.0.66/1.0.79 (`com.github.copilot/extensions/`).

**g) Copilot SDK (GA, separate from the in-CLI extension API)** — github/copilot-sdk: "same engine behind Copilot CLI" invoked programmatically; official Node/Python/Go/.NET/Rust/Java packages; JSON-RPC to a Copilot CLI server; permission handlers, agents/skills/MCP/hooks. An in-process orchestration option for lanes.

**h) Custom agents / subagents** — `*.agent.md` in `.github/agents/` or `~/.copilot/agents/`; frontmatter `name`, `description`, `instructions`, `tools` (e.g. `gh, git, semgrep`), model fallback list (1.0.83). Invoke via `/agent`, inference, or headless `copilot --agent security-auditor -p "..."`. Runs in a subagent with own context window; nested subagents (`subagents.maxDepth` default 4), concurrency/depth limits in `/settings`, parallel delegation exists (1.0.76+). **No public "spawn N named parallel subagents" API.**

**i) Skills** — SKILL.md folders in `.github/skills`, `.claude/skills`, `.agents/skills`, `~/.copilot/skills`, `~/.agents/skills`. Model-invoked or `/skill-name`. `copilot skill list/add`, `gh skill` registry. Cross-tool Agent Skills convention.

**j) Plugins + marketplaces** — `copilot plugin install|uninstall|list|update|enable|disable`, `copilot plugin marketplace add|list|browse|update|remove`; specs `plugin@marketplace`, `OWNER/REPO`, git URL, local path. `plugin.json` manifest with `agents`, `skills`, `commands`, `hooks`, `extensions`, `mcpServers`, `lspServers`. `marketplace.json` distribution, SHA pinning. Installed to `~/.copilot/installed-plugins/`; writable data dir `${COPILOT_PLUGIN_DATA}`.

## 3. GitHub App Copilot Extensions — dead

Deprecated Nov 10 2025, replaced by MCP. Do not target.

## 4. Agent Plugins protocol (agent-plugins.org)

- v1.0.0 published 2026-08-06; v1.1.0 working draft. Maintainers: Amazon, Anysphere (Claude), Microsoft, OpenAI, Vercel; Google joined Aug 2026.
- **Portable core is deliberately minimal: skills/ + mcp.json only.** Client-specific extras live in reverse-DNS dirs (e.g. `com.github.copilot/` for agents, commands, rules, hooks, extensions).
- Copilot CLI: native support since 1.0.74 (manifest + mcp.json); 1.0.79 plugins may ship CLI extensions. VS Code, Copilot CLI/SDK/app GA; Kiro supports; Cursor/Codex reported supporters; Claude Code adoption uncertain (spec mirrors `.claude-plugin`).
- Consequence: cross-platform via Agent Plugins ≈ skills + MCP only; the heavy machinery (tools+commands+subprocess lanes) would be Copilot-specific or shipped as an MCP server.

## 5. Feature mapping pi → Copilot CLI

| pi-pr-review feature | Copilot CLI equivalent |
|---|---|
| `/pr-review` slash command | Extension SDK command (experimental) or plugin `commands`; markdown slash files unsupported |
| Parallel reviewer subprocesses | (a) spawn `copilot --agent <reviewer> -p ... --output-format json` lanes; (b) Copilot SDK in-process; (c) built-in subagent delegation (opaque, bounded) |
| Custom tools for model | Extension `tools` or MCP stdio server (both work headless) |
| TUI widgets | No raw TUI API; elicitation dialogs, `session.log`, session-scoped canvases (limited) |
| JSON config | Plain files; `${COPILOT_PLUGIN_DATA}` |
| `gh` usage | shell tool with `--allow-tool 'shell(gh ...)'` scoping; agents' `tools:` allowlists; built-in GitHub MCP server |
| Distribution | Copilot plugin + marketplace.json; optional dual Agent Plugins 1.0 manifest |

## 6. Known gaps / risks

- Markdown slash commands unsupported (FRs #9, #1113).
- Extension API experimental, iterating fast; some features only community-documented.
- No custom keybindings; canvases ≠ raw TUI widgets.
- No public parallel-subagent spawn primitive → lanes must be subprocesses or SDK.
- Input interception/transform, message rewriting, dynamic tool visibility: **no equivalents found** — port must redesign around execute-time checks (defense exists in pi-pr-review as defense-in-depth) and static tool exposure.
- Agent Plugins portable core (skills+MCP) can't carry commands/agents/hooks — cross-agent reach means a different (thinner or MCP-based) architecture.

## Key sources

- https://docs.github.com/copilot/how-tos/copilot-cli/customize-copilot (customize hub)
- https://docs.github.com/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
- https://docs.github.com/copilot/how-tos/copilot-cli/customize-copilot/use-hooks
- https://docs.github.com/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli
- https://docs.github.com/copilot/how-tos/copilot-cli/customize-copilot/add-skills
- https://docs.github.com/copilot/reference/copilot-cli-reference/cli-plugin-reference
- https://docs.github.com/copilot/reference/copilot-cli-reference/cli-command-reference
- https://docs.github.com/copilot/tutorials/create-an-extension
- https://github.com/github/copilot-cli (repo + changelog.md)
- https://github.com/github/copilot-sdk
- https://agent-plugins.org/ + https://agent-plugins.org/specification
- https://github.blog/changelog/2026-08-12-agent-plugins-1-0-in-vs-code-copilot-cli-and-the-copilot-app/
