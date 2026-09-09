# Roadmap — pr-review-glm

The full increment plan and where we are on the journey. Authoritative for status;
the [design spec](docs/superpowers/specs/2026-09-09-copilot-pr-review-port-design.md) is
authoritative for what each increment must deliver.

**Where we are:** I1 complete (PR #3). **Next:** I2 — read-only PR capture.

Core principles (from the spec): small sequential increments, each landing as a PR;
dogfood from I3 onward — every increment PR is reviewed by this tool itself before merge.

## Increments

| ID | Status | Independently demonstrable outcome | Depends on |
|----|--------|------------------------------------|------------|
| I0 | ✅ Done (PR #2) | Project context persisted: README, AGENTS.md, HANDOFF.md, ROADMAP, ATTRIBUTION policy; repo public with `main` PR-protected. | — |
| I1 | ✅ Done (PR #3) | Installable plugin skeleton: `plugin.json` + extension registering `/pr-review` (status/help only) and `/pr-review-config show\|set\|unset`; schema-versioned config at `~/.copilot/pr-review-glm/config.json` (tiers, default mode, autoPostReviews, deadlines). No model calls; no-inference smoke script proves command registration + config round-trip. Evidence: 48 unit tests (`node --test tests/*.test.mjs`) + `node tests/smoke-i1.mjs` (SDK-dispatched commands, zero inference events, 0600 config round-trip). | I0 |
| I2 | ⬜ Pending | Read-only PR capture: `/pr-review N --capture-only` fetches metadata/base/head/diff via `gh` into a 0600 temp file, freezes repo/PR binding, enforces draft/closed gates; fail-closed consistency checks. Demonstrated against a real PR, zero inference. | I1 |
| I3 | ⬜ Pending | **First minimal review (dogfood entry point):** one heavy lane over the captured diff via a Copilot SDK child runtime (envelope-marker contract), findings parsed and rendered in-chat. From here, every increment PR is reviewed by this tool. | I2 |
| I4 | ⬜ Pending | Topologies and tiers: quick/balanced/full/deep lane sets, light/medium/heavy models + one fallback each from config, concurrent lanes with per-lane progress, attempt/total budgets with cancellation. | I3 |
| I5 | ⬜ Pending | Validation and adjudication: deterministic candidate validation (severity ladder, anchors vs diff, evidence), isolated adjudicator call, dedup, per-mode findings policy, degraded assembly with coverage disclosure. | I4 |
| I6 | ⬜ Pending | Selection and retention: elicitation-based finding selection (`--all`, subset, none), retained settled result inspectable without inference. | I5 |
| I7 | ⬜ Pending | Gated COMMENT publication: single POST, ≤50 validated inline anchors, idempotency marker, stale/draft/self gates, uncertain-write reconciliation; `--comment` / `autoPostReviews`. | I6 |
| I8 | ⬜ Pending | Hardening: large-diff file-backed transport (≥200 KB manifest + required read ranges), lane/credit telemetry from runtime events, dogfood-driven fixes. | I7 |

Sizes are deliberately small (a focused session each). Later items may split further
without changing the spec; record splits here.

## Journey log

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
