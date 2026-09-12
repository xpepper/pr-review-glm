# AGENTS.md — working guide for agents (and humans) in this repo

Read this before doing anything. It evolves with the project; keep it current.

## What this project is

The `pr-review-glm` repository (repo name unchanged) hosts **z-pr-review**, a
personal-use GitHub Copilot CLI plugin porting the review workflow of
[pi-pr-review](https://github.com/10ego/pi-pr-review) (upstream, MIT-declared): parallel
tiered reviewer lanes, host-validated findings, and gated GitHub COMMENT publication.
The plugin identity was renamed to z-pr-review by R1 (2026-09-10); commands are
`/z-pr-review` and `/z-pr-review-config`.

- Design spec (authoritative for behavior and settled decisions):
  `docs/superpowers/specs/2026-09-09-copilot-pr-review-port-design.md`
- Research notes: `docs/research/pi-pr-review-architecture.md` (upstream map),
  `docs/research/copilot-cli-extensibility.md` (platform capabilities)
- Status and plan: `ROADMAP.md` · Next-session instructions: `HANDOFF.md`

## Core principles (non-negotiable)

1. **Small, sequential increments.** Each ROADMAP increment is developed alone, in order,
   and demonstrated before the next starts. No big upfront builds.
2. **Dogfood from I3 onward.** Every increment lands as a PR on this repo and is reviewed
   with this tool itself before merging (conventional review before I3 exists).
3. **Never push to `main` directly.** Branch → PR → review → squash merge → delete branch.
   `main` is server-protected (PRs required, admins bound, no force pushes).

## Per-increment workflow

1. Read `HANDOFF.md`, `ROADMAP.md`, the spec, and open PRs; check `git state`.
2. Plan the increment briefly (a short design note in the PR description is enough at this
   size); confirm boundaries if anything is ambiguous — don't reopen settled decisions.
3. Branch `i<N>-<slug>`; implement; add/extend tests and no-inference smoke scripts.
4. Update `ROADMAP.md` (status + journey log) and rewrite `HANDOFF.md` for the next
   session as part of the same PR.
5. Open a PR referencing the increment ID; after review, squash merge and delete the branch.
6. Automation (from L1): the sequence above can be driven by `node scripts/dev-loop.mjs`
   (spec: docs/superpowers/specs/2026-09-10-dev-loop-design.md). The loop owns merging;
   agents working increments never merge. Default is one iteration per run and
   `--merge human`; `--merge auto` (landed L2) is a loop-owned merge on green gates +
   clean active reviews and an unchanged reviewed head (headRefOid pinned at
   assessment, re-checked immediately before merging) — never an agent-discretion
   merge — and, once the dogfood review exists (I3+), additionally requires it.

## Settled decisions — do not reopen

Architecture A (code-owned orchestrator in a plugin extension; reviewer lanes as Copilot
SDK child runtimes) · envelope-marker output contract (structured output is broken on
Copilot CLI 1.0.83) · lane read-only tools `view`/`rg`/`glob` confined by permission
handler · plugin identity **z-pr-review** (R1, 2026-09-10: plugin name, commands
`/z-pr-review` + `/z-pr-review-config`, extension dir `extensions/z-pr-review/` — command
names are the collision surface across sibling pr-review ports on this machine; repo name
stays `pr-review-glm`) · config at `~/.copilot/z-pr-review/config.json` (amended by R1
from `~/.copilot/pr-review-glm/`; user-local and schema-versioned, starts fresh — no
migration — and not the prior prototype's path) · COMMENT-only publication in v1 ·
upstream `lib/` reused with attribution.

## Environment facts (verified 2026-09-09, Copilot CLI 1.0.83)

- Extensions load from plugins (`plugin.json` → `extensions/`), need `--experimental`
  for now; local testing via `copilot --plugin-dir <repo>` (fresh session after edits).
- Extension entry imports `joinSession` from `@github/copilot-sdk/extension` (bundled
  with the CLI; also `CopilotClient`/`RuntimeConnection` from `@github/copilot-sdk` for
  owned child runtimes).
- Headless: `copilot -p "…" --output-format json` (JSONL events: `assistant.message`,
  `model.call_finished`, `session.usage_checkpoint`, …); per-invocation `--model` and
  `--effort none|minimal|low|medium|high|xhigh|max`.
- The prior clean-room prototype was **uninstalled** on 2026-09-09 (I1): it registers
  `/pr-review` command names — the names this plugin used until the R1 rename — and with
  both loaded, dispatch is ambiguous (last registrant wins, order unspecified). Since R1
  this plugin registers `/z-pr-review` names, so sibling ports (the prototype,
  gem-pr-review) no longer collide with it by name; the prototype has kept re-registering
  itself (I1 hazard, recurred at L1 and R1). The dev-loop's prototype-absent preflight
  gate — whose remedy was `copilot plugin uninstall copilot-pr-review` (it does not trip
  on gem-pr-review) — was **removed** on 2026-09-10: with unique command names the
  prototype being registered is benign for this plugin, and the gate hard-failed loop
  runs on that benign condition. Its source checkout at
  `~/Documents/workspace/ai/pr-review` is untouched and remains a reference for runtime
  facts only, never a code source. Direct (`_direct`) installs cannot be disabled, only
  uninstalled; `plugins uninstall` removes the cache copy, not the source.
- Markdown prompt slash-commands exist only via plugin `commands/` dirs; our commands
  are extension-registered code.
- Headless command dispatch (learned I1): `copilot -p "/z-pr-review" …` does NOT execute
  the command — the slash text goes to the model as an ambient turn. Direct, inference-
  free dispatch is via the SDK: spawn `RuntimeConnection.forStdio({ path, args:
  ["--plugin-dir", repo, "--experimental"] })`, `client.createSession({ …,
  requestExtensions: true, enableExperimentalMode: true })`, then
  `session.rpc.commands.execute({ commandName, args })`; output arrives as
  `session.info`/`session.error` events. Bundled SDK lives at
  `~/.copilot/pkg/<arch>/<version>/copilot-sdk` (derive from `copilot --version`); see
  `tests/smoke-i1.mjs`.

## Environment facts — zcode CLI (loop worker; verified 2026-09-10, 0.16.5 in ZCode.app 3.11.2)

- Binary: `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` (executable,
  spawns directly); `ZCODE_CLI` env overrides; `zcode doctor` inspects packaging.
- `--max-turns` and `--settings` are listed by `--help` but **rejected by the
  parser** (exit 1 + usage dump) — the dev-loop sends neither; per-phase bounds
  are wall-clock timeouts only. Re-check after app updates.
- Standalone headless `--prompt` ignores the running app's OAuth; it needs model
  config + auth of its own:
  - `~/.zcode/cli/config.json` is read strictly: any schema violation unloads the
    whole file (surfacing as a generic "Model config is missing"). Working shape:
    `"model": "zai/glm-5.3"` (a `provider/model` string), plus a top-level
    `"provider": {"zai": {"kind": "anthropic", "options": {"baseURL":
    "https://api.z.ai/api/anthropic"}}}` for the Z.AI coding-plan endpoint
    (`kind` is required; `anthropic|openai|openai-compatible`; bigmodel uses
    `https://open.bigmodel.cn/api/anthropic`).
  - Auth (**verified end-to-end 2026-09-10**): the env var `ZAI_API_KEY`
    (alternatives: `ANTHROPIC_API_KEY`, `ZCODE_API_KEY`, or an inline
    `provider.<id>.options.apiKey`) — the keyless `zcode login` route (note: the
    binary is not on PATH; use its full path) remains unverified. Launch the
    dev-loop from a shell where the var is set; the preflight `zcode-headless`
    gate runs a one-turn probe and fails fast with the CLI's own error line when
    any of this is missing.
- `--mode yolo` (default for `--prompt`), `--cwd`, `--disallowed-tools` parse and
  work as the loop uses them. **`--disallowed-tools` never matches MCP tools** —
  no denylist shape does on 0.16.5 (`mcp__*`, bare server names, exact names:
  all parser-accepted, all ineffective; observed live twice when reviewer agents
  invoked playwright MCP tools and popped a visible automation Chrome, I4 and
  V1). The `--allowed-tools` allowlist is parser-dead like `--max-turns`.
- Headless phases therefore run with an **isolated HOME** (`buildPhaseEnv` in
  `scripts/dev-loop/phases.mjs`, PR #24): a temp HOME containing only the copied
  model config, so MCP servers, plugins, and skills never exist for a phase —
  verified Chrome-free in supervised runs. `GIT_CONFIG_GLOBAL`/`GH_CONFIG_DIR`
  redirect git identity and gh config to the real HOME; gh's keyring token is
  unreachable under a redirected HOME ("token invalid"), so the loop resolves
  `gh auth token` once in its own env and carries it as `GH_TOKEN` (PR #26), and
  pins the git credential helper to gh's. Re-verify after CLI updates, like
  every other flag.

## Conventions

- Plain ESM JavaScript (`.mjs`) for the extension and modules; no build step in v1.
- Tests: `node --test` unit tests + smoke scripts under `tests/` (SDK-dispatch
  smoke scripts share `tests/smoke-harness.mjs` — extend it, don't fork it; script smokes
  that never touch the Copilot SDK, like `tests/smoke-l1.mjs`, don't use the harness).
  smoke-i1/i2 are no-inference; `tests/smoke-i3.mjs` dispatches a real review whose lane
  child performs inference **by design** — the harness still asserts the parent session
  stream stays inference-free.
- Any code ported from upstream pi-pr-review keeps provenance: note it in
  `docs/ATTRIBUTION.md` (module, upstream version, commit) — see the attribution policy there.
- Keep model-influenced output out of authority paths: gates, anchors, publication
  decisions are code-owned only (spec: "Publication gates").
