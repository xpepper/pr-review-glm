# pi-pr-review v1.18.1 — Architecture & Platform-Dependency Report

Source: clone of https://github.com/10ego/pi-pr-review (npm `pi-pr-review`, pi package page: https://pi.dev/packages/pi-pr-review).
Purpose: input for porting to GitHub Copilot CLI. Researched 2026-09-09.

Repo is a **pi extension package** (`"pi": { "extensions": ["./extensions/index.ts"], "prompts": ["./prompts"] }`), peer-depending on `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui` (>=0.84.4) and `typebox`. TypeScript under the pi extension loader (Node 20+/Bun).

## 1. Entry points & registration

- `extensions/index.ts:9-15` — `export default function registerPrReview(pi: ExtensionAPI)`. Creates `ReviewLoopCoordinator` (`lib/pr-review-loop.ts:120`) and `SelfReviewPermitCoordinator` (`lib/pr-self-review.ts:618`), then delegates to:
  - `registerPrReviewSubagents(pi, ...)` (`extensions/pr-review-subagent.ts:1617`) — 5 custom tools + `/pr-review-config`
  - `registerReviewFocus(pi, ...)` (`extensions/pr-review-focus.ts:242`) — `/pr-review-focus` + global shortcut
  - `registerReviewTable(pi, ...)` (`extensions/review-table.ts:503`) — `/pr-review-publish` + session/agent event hooks

| Command | Mechanism | Where |
|---|---|---|
| `/pr-review` | **Prompt template only** (`prompts/pr-review.md`, `$1`/`$@` args) | verified via `isOwnReviewPrompt()` `review-table.ts:120-133` |
| `/pr-review-config` | Code-registered command + TUI menu | `pr-review-subagent.ts:2229-2276` |
| `/pr-review-focus` | Code command + `registerShortcut("ctrl+alt+r")` | `pr-review-focus.ts:267-281` |
| `/pr-review-publish` | Code-registered command | `review-table.ts:779-816` |

Hybrid design: methodology lives in the prompt; code intercepts the `/pr-review` input **before** template expansion via the `input` event (`review-table.ts:865-999`), freezes trusted state, and may `{action:"transform", text}` (append default mode flag).

### `prompts/pr-review.md` (250 lines)
Frontmatter + role; review modes (`--quick` 3 heavy, `--balanced` 5 (default), `--full` 6 (+medium conventions), `--deep` 1 integrated heavy); topology contract (orchestrator LLM calls `review_subagents` with fixed ordered ids+objectives; host owns tiers/tools/concurrency); argument semantics (`--comment`/`--no-comment`, `--incremental`, `--include-closed`); Step 1 exact `gh` snippets (`gh pr view`, `gh pr diff > mktemp`, `gh repo view`, `gh api user`); Steps 2–6 convention files, overview pass, fixed batch dispatch, `pr_review_verify`; Step 7 validation/classification rules (severity ladder, diff-anchor rules); OUTPUT FORMAT Markdown skeleton (verdict, findings `### [P1]` blocks with Severity/Rationale/Confidence/Location, Lane completeness, Strengths).

## 2. Pi API surface (what a port must replace)

Imports: `ExtensionAPI`, `ExtensionContext`, `CONFIG_DIR_NAME`, `getAgentDir()`, `getSelectListTheme()/getSettingsListTheme()`, `Theme` (coding-agent); `Message`, `StringEnum` (pi-ai); `Container, Input, SelectList, SettingsList, Text, fuzzyFilter, getKeybindings, Component, TUI, matchesKey, truncateToWidth, wrapTextWithAnsi` (pi-tui); `Type` (typebox).

`ExtensionAPI` methods used:
- `pi.registerTool({name,label,description,promptSnippet,promptGuidelines,parameters,execute(toolCallId,params,signal,onUpdate,ctx)})` — 5 tools
- `pi.registerCommand(name,{description,handler,getArgumentCompletions})`
- `pi.registerShortcut("ctrl+alt+r",...)`
- `pi.on(event,...)`: `input` (intercept/transform/handle; has `source: interactive|rpc|extension`), `turn_start/end`, `tool_execution_start/end`, `message_end` (handler may **return a rewritten message**), `session_start/before_switch/before_fork/before_tree/shutdown`, `session_tree`, `before_agent_start`, `agent_settled`
- `pi.appendEntry(type,data)` — custom session-JSONL persistence (completed-review cache, telemetry, extraction entries)
- `pi.sendMessage({customType,content,display,details},{triggerTurn:false})` — display-only message
- `pi.getCommands()`, `pi.getActiveTools()/setActiveTools()` — dynamic tool visibility

`ExtensionContext`: `cwd`, `isProjectTrusted()`, `hasUI`, `mode`, `abort()`, `ui.notify`, `ui.custom((tui,theme,keybindings,done)=>Component)` (full-screen TUI), `sessionManager` (getSessionId/getHeader/getBranch/getLeafEntry), `modelRegistry.getAvailable()`.

### Child pi CLI surface (subprocess contract)
- Reviewer children: `pi --mode json -p --no-session --no-context-files --no-extensions --no-skills --no-prompt-templates --no-themes --model <spec> --thinking <level> [--tools a,b,c|--no-tools] --append-system-prompt <tmpfile>`; task piped on **stdin** (`lib/pr-review-policy.ts:11-23`).
- JSON-mode stdout = newline-delimited events: `message_start`, `message_update` (`text_delta`), `message_end` (full message, stopReason, errorMessage), `tool_execution_start/end`. Decoder `ReviewJsonLineDecoder` (`lib/pr-review-focus.ts:58-83`), parsed in `runReviewSubprocess` (`pr-review-subagent.ts:667-737`).
- Self-review uses `--mode rpc` + `PI_CODING_AGENT_DIR` isolated agent dir with symlinked auth/models and retry/compaction disabled (`lib/pr-self-review-rpc.ts`).

## 3. Reviewer lane execution model

Parent = normal pi agent loop (LLM orchestrator following the prompt); **each reviewer lane = spawned `pi` subprocess** (`spawn(..., {detached:true})`, pgid = pid). Per-attempt deadlines; on timeout SIGTERM to process group → `terminationGraceMs` (5s) → SIGKILL → bounded drain. Attempt math: `attemptMs` light 3m / medium 6m / heavy 12m, fallback 3m, `batchMs` 12m (activates at first dispatch), `synthesisMs` 1m, `totalMs` 15m hard cap, cleanup reserve 5s. Retry policy: at most 1 retry on retryable (429/quota/overload), at most 2 attempts total, configured fallback chain. Concurrency = topology size (`runWithConcurrency`, ordered).

Model attempts: primary tier → nearest configured tier → pi default → fallback chain.

## 4. Custom tools registered for the model

1. **`review_subagent`** — single lane: `tier, objective, context?, context_file?, tool_policy?, major_only?, minor_hygiene?`
2. **`review_subagents`** — fixed batch: `passes:[{id,objective,context?}], context_file?, context?`; ids must **exactly match** mode's `FIXED_REVIEW_TOPOLOGIES`; metadata byte caps; ≥200,000-byte diffs switch to **file-backed mode** (read-only tools `read,grep,find,ls` + changed-file manifest + exact required read ranges; completeness enforced from stdout events)
3. **`pr_review_verify`** — `action: list|run`; strict user-level profiles (exact repo identity, canonical absolute argv, POSIX platforms, timeout, allowForks, mandatory risk acknowledgement); bare staging repo fetch with gh-token askpass; detached worktree; scrubbed env; group TERM/KILL
4. **`pr_review_prior`** — reads GitHub reviews/comments/commits via `gh api`; finds latest marker-bearing review by same identity; classifies `none|same_head|incremental|diverged`
5. **`self_review_subagent`** — zero-arg one-shot; reviews current top-level task's working-tree delta; permit armed at `before_agent_start` (clean-tree baseline), bound to single tool-call id, consumed atomically; strict JSON findings schema host-validated against diff anchors

**Loop lease** (`lib/pr-review-loop.ts`): generation-scoped binding (cwd+sessionId+AbortController+ReviewBudget+total timer); tools enabled only during active loop; every `execute()` re-acquires; any new input/session event/deadline revokes; input hook requires `source: interactive|rpc`.

## 5. TUI usage

- `review-table.ts` renders **Markdown** (findings table + sections) by rewriting the assistant message on `message_end`; print/json/rpc get deterministic degraded body.
- `pr-review-focus.ts` = custom full-screen pi-tui `Component` (render/handleInput/invalidate/dispose) opened via `ctx.ui.custom`; per-pass status, bounded assistant text (48 KiB/pass, 256 KiB total, eviction), Tab/←/→/↑/↓/PgUp/PgDn/Home/End/Esc.
- Config menu (`/pr-review-config`) = `ctx.ui.custom` + `SettingsList`, model picker from `Input`+`SelectList`+`fuzzyFilter`; persists to `~/.pi/agent/pr-review.json` (mode 0600).

## 6. End-to-end flow of `/pr-review N`

1. Input interception: parse flags, load config (user `getAgentDir()` + trusted-project `.pi/`), resolve deadlines, **preflight `resolveReviewHostBinding`** (`gh repo view` + `gh api pulls/N`) freezing repo/PR/title/head/state; `loopCoordinator.begin()`; transform input (default mode flag).
2. Prompt expands; orchestrator LLM runs `gh` commands per prompt (metadata, diff→0600 mktemp, repo, user).
3. `review_subagents` spawns N isolated children concurrently, streams/validates/retains artifacts; optional `pr_review_verify` concurrent.
4. Synthesis: orchestrator emits Markdown review; `message_end` → `synthesizeReviewArtifact` parses/validates (degraded machinery, lane-fallback assembly, prior disclosures); cached in `CompletedReviewCache`; message rewritten for display; optional finding-extraction child.
5. Publication at `turn_end`: decide publication; per-target lock; identity/head/stale/draft gates; `pulls/N/files` anchor validation; build payload (concise body + ≤50 inline comments + canonical marker); final head check; **single POST** `gh api --method POST repos/{repo}/pulls/N/reviews --input -`; uncertain-failure reconciliation by marker scan.
6. Later publication: `/pr-review-publish N [--allow-stale]` or matched natural-language request, from session cache only.

## 7. Module map

| File | Responsibility |
|---|---|
| `extensions/index.ts` | Entry; wires coordinators into registrars |
| `extensions/pr-review-subagent.ts` | Config model, fixed topologies, subprocess spawner, attempts/fallbacks, 5 tools, `/pr-review-config`, extraction runner |
| `extensions/review-table.ts` | Event orchestrator: input interception, preflight, synthesis/cache/render, publish, telemetry |
| `extensions/pr-review-focus.ts` | Full-screen live viewer + shortcut |
| `lib/pr-review-loop.ts` | Loop lease, tool visibility, deadline timers |
| `lib/pr-review-policy.ts` | Child argv + tool policy flags |
| `lib/pr-review-concurrency.ts` | Ordered bounded-parallel map |
| `lib/pr-review-deadlines.ts` / `-deadline-config.ts` | Budget math + config overlay |
| `lib/pr-review-context.ts` | `context_file` diff loading (≤1 MiB) |
| `lib/pr-review-artifacts.ts` | Lane completion grammar, lifecycle classification, artifact registry |
| `lib/pr-review-focus.ts` | JSONL decoder, focus snapshots with byte caps |
| `lib/pr-review-markdown.ts` | Synthesis parse/validate, degraded body, merge extraction |
| `lib/pr-review-publish.ts` | Publication domain: gates, payload builders, cache, gh runner |
| `lib/pr-review-prior.ts` | Prior-review discovery + revalidation registry |
| `lib/pr-review-extract.ts` | Experimental finding extraction (quote provenance) |
| `lib/pr-review-telemetry.ts` | Timing trackers |
| `lib/pr-review-thinking.ts` | Thinking-level resolution |
| `lib/pr-review-verify.ts` | Verification baselines (staging repo, worktree, supervision) |
| `lib/pr-self-review.ts` / `-rpc.ts` | Self-review permits, delta capture, RPC child supervision |
| `lib/trusted-executable.ts` | Canonical git/gh resolution from startup PATH |

## 8. Pi-specific, no obvious Copilot equivalent (port risk)

1. Input interception with transform/handle
2. Assistant-message rewriting on `message_end`
3. Dynamic tool visibility (`setActiveTools`)
4. Session JSONL `appendEntry` + sessionManager introspection (cache persistence)
5. Prompt-template packages with `$1`/`$@` + provenance introspection
6. Child invocation modes (`--mode json -p`, `--mode rpc`) with isolation flags — **the whole lane design depends on spawning the same agent CLI headlessly**
7. TUI peer API (full-screen components, themes, global shortcuts)
8. Trusted-project config gating
9. `PI_CODING_AGENT_DIR` credential sharing for isolated children
10. `modelRegistry.getAvailable()`, `provider/model:thinking` spec grammar
11. `sendMessage` display-only messages
12. RPC input source as first-class user authority

**Portable core (no pi imports):** concurrency, context, deadlines, policy (minus flag names), verify, prior, publish (uses only `spawn("gh")`), markdown, extract, artifacts, telemetry, thinking, trusted-executable, non-coordinator self-review. **Pi-coupled surface to reimplement:** extension registration/lifecycle, input/turn/message interception, dynamic tool visibility, session persistence, child invocation modes, TUI surfaces.
