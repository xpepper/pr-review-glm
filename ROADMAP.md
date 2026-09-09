# Roadmap — pr-review-glm

The full increment plan and where we are on the journey. Authoritative for status;
the [design spec](docs/superpowers/specs/2026-09-09-copilot-pr-review-port-design.md) is
authoritative for what each increment must deliver.

**Where we are:** I2 complete (PR #6). **Next:** L1 — dev-loop.

Core principles (from the spec): small sequential increments, each landing as a PR;
dogfood from I3 onward — every increment PR is reviewed by this tool itself before merge.

## Increments

| ID | Status | Independently demonstrable outcome | Depends on |
|----|--------|------------------------------------|------------|
| I0 | ✅ Done (PR #2) | Project context persisted: README, AGENTS.md, HANDOFF.md, ROADMAP, ATTRIBUTION policy; repo public with `main` PR-protected. | — |
| I1 | ✅ Done (PR #3) | Installable plugin skeleton: `plugin.json` + extension registering `/pr-review` (status/help only) and `/pr-review-config show\|set\|unset`; schema-versioned config at `~/.copilot/pr-review-glm/config.json` (tiers, default mode, autoPostReviews, deadlines). No model calls; no-inference smoke script proves command registration + config round-trip. Evidence: 48 unit tests (`node --test tests/*.test.mjs`) + `node tests/smoke-i1.mjs` (SDK-dispatched commands, zero inference events, 0600 config round-trip). | I0 |
| I2 | ✅ Done (PR #6) | Read-only PR capture: `/pr-review N --capture-only [--include-drafts] [--include-closed]` fetches metadata/base/head/diff via `gh` into a 0600 temp file, freezes repo/PR binding, enforces draft/closed gates, refuses fail-closed on unauthenticated `gh`, gh errors/timeouts, inconsistent repo/head state (incl. a head-moved re-check after the diff fetch), or empty diff. Evidence: 81 unit tests (`node --test tests/*.test.mjs`, incl. fake-`gh` capture suite) + `node tests/smoke-i2.mjs` (SDK-dispatched capture of real PR #3 with closed-gate refusal, 0600 envelope, frozen binding, zero inference events; harness shared with smoke-i1 via `tests/smoke-harness.mjs`; also demonstrated against open PR #6 itself). | I1 |
| L1 | ⬜ Pending | **dev-loop** (non-plugin increment): `scripts/dev-loop.mjs` orchestrating fresh headless agent phases per increment (worker → gates → independent review → fixer → merge), `STATUS:` protocol in HANDOFF, prompt templates, `--dry-run`. Spec: `docs/superpowers/specs/2026-09-10-dev-loop-design.md`. | I2 |
| I3 | ⬜ Pending | **First minimal review (dogfood entry point):** one heavy lane over the captured diff via a Copilot SDK child runtime (envelope-marker contract), findings parsed and rendered in-chat. From here, every increment PR is reviewed by this tool — via the dev-loop. | I2, L1 |
| I4 | ⬜ Pending | Topologies and tiers: quick/balanced/full/deep lane sets, light/medium/heavy models + one fallback each from config, concurrent lanes with per-lane progress, attempt/total budgets with cancellation. | I3 |
| I5 | ⬜ Pending | Validation and adjudication: deterministic candidate validation (severity ladder, anchors vs diff, evidence), isolated adjudicator call, dedup, per-mode findings policy, degraded assembly with coverage disclosure. | I4 |
| I6 | ⬜ Pending | Selection and retention: elicitation-based finding selection (`--all`, subset, none), retained settled result inspectable without inference. | I5 |
| I7 | ⬜ Pending | Gated COMMENT publication: single POST, ≤50 validated inline anchors, idempotency marker, stale/draft/self gates, uncertain-write reconciliation; `--comment` / `autoPostReviews`. | I6 |
| I8 | ⬜ Pending | Hardening: large-diff file-backed transport (≥200 KB manifest + required read ranges), lane/credit telemetry from runtime events, dogfood-driven fixes. | I7 |

Sizes are deliberately small (a focused session each). Later items may split further
without changing the spec; record splits here. Non-plugin increments (L-series) carry
the development workflow itself.

## Journey log

- **2026-09-10 (I2)** — Read-only PR capture landed: `capture.mjs` (gh auth pre-check,
  repo-binding freeze via `gh repo view`, `gh pr view --json` + `gh pr diff` with
  number-echo/SHA-shape/base≠head consistency checks, draft/closed skip gates, 0600
  temp-file envelope with the diff embedded), full review-flag grammar in
  `parseReviewArgs` (inert flags rejected with `--capture-only`), `renderStatus`/
  `renderHelp`/`renderCapture`, and the smoke harness extracted to
  `tests/smoke-harness.mjs` so smoke-i1 and the new smoke-i2 share one no-inference
  dispatch path. Runtime facts: none new — the I1 SDK dispatch pattern carried over
  unchanged; `gh` runs as a plain child process of the extension (invisible to the
  session event stream, which is what the zero-inference assertion checks).

- **2026-09-10 (dev-loop design)** — Approved in conversation: a script-orchestrated
  increment loop (`scripts/dev-loop.mjs`) with fresh headless agent phases, deterministic
  gates, dual review before auto-merge (independent reviewer always; the plugin's own
  dogfood review from I3; human merges until then), `STATUS:` protocol in HANDOFF.
  Spec in this PR; ROADMAP amended with L1 between I2 and I3.

- **2026-09-09** — Research (upstream pi-pr-review v1.18.1 architecture map, Copilot CLI
  extensibility, prior `copilot-pr-review` prototype facts), design approved through
  Q&A, spec written and merged (PR #1) with the two core principles. Repo pushed
  public; `main` protected (PRs required, admins bound, force pushes off). I0 merged (PR #2).
- **2026-09-09 (I1)** — Plugin skeleton + configuration landed: `plugin.json`, extension
  registering `/pr-review status|help` and `/pr-review-config show|set|unset`,
  schema-versioned 0600 config store with whole-object validation, 46 unit tests and an
  SDK-dispatched no-inference smoke script. Runtime facts learned en route: headless
  `copilot -p "/cmd"` starts an ambient model turn (direct dispatch must go through SDK
  `commands.execute`); two plugins registering the same command name dispatch
  ambiguously — the prior prototype was uninstalled (source checkout untouched).
  MIT LICENSE added.

## Backlog (post-v1, from the spec's out-of-scope list)

Incremental re-review (`--incremental` + prior-findings revalidation) · verification
profiles (tests against PR head in detached worktree) · self-review one-shot · APPROVE
publication with `approveMaxPriorityLevel` · project-trust config overrides ·
cross-session persistence of retained results · experimental finding extraction ·
live lane viewer UX · semantic benchmark suite · marketplace publishing · Agent Plugins
1.0 packaging (skills + MCP) for other agents.
