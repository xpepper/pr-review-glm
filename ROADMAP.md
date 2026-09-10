# Roadmap — pr-review-glm

The full increment plan and where we are on the journey. Authoritative for status;
the [design spec](docs/superpowers/specs/2026-09-09-copilot-pr-review-port-design.md) is
authoritative for what each increment must deliver.

**Where we are:** L2 complete (PR #9). **Next:** I3 — first minimal review (dogfood entry point).

Core principles (from the spec): small sequential increments, each landing as a PR;
dogfood from I3 onward — every increment PR is reviewed by this tool itself before merge.

## Increments

| ID | Status | Independently demonstrable outcome | Depends on |
|----|--------|------------------------------------|------------|
| I0 | ✅ Done (PR #2) | Project context persisted: README, AGENTS.md, HANDOFF.md, ROADMAP, ATTRIBUTION policy; repo public with `main` PR-protected. | — |
| I1 | ✅ Done (PR #3) | Installable plugin skeleton: `plugin.json` + extension registering `/pr-review` (status/help only) and `/pr-review-config show\|set\|unset`; schema-versioned config at `~/.copilot/pr-review-glm/config.json` (tiers, default mode, autoPostReviews, deadlines). No model calls; no-inference smoke script proves command registration + config round-trip. Evidence: 48 unit tests (`node --test tests/*.test.mjs`) + `node tests/smoke-i1.mjs` (SDK-dispatched commands, zero inference events, 0600 config round-trip). | I0 |
| I2 | ✅ Done (PR #6) | Read-only PR capture: `/pr-review N --capture-only [--include-drafts] [--include-closed]` fetches metadata/base/head/diff via `gh` into a 0600 temp file, freezes repo/PR binding, enforces draft/closed gates, refuses fail-closed on unauthenticated `gh`, gh errors/timeouts, inconsistent repo/head state (incl. a head-moved re-check after the diff fetch), or empty diff. Evidence: 81 unit tests (`node --test tests/*.test.mjs`, incl. fake-`gh` capture suite) + `node tests/smoke-i2.mjs` (SDK-dispatched capture of real PR #3 with closed-gate refusal, 0600 envelope, frozen binding, zero inference events; harness shared with smoke-i1 via `tests/smoke-harness.mjs`; also demonstrated against open PR #6 itself). | I1 |
| L1 | ✅ Done (PR #7) | **dev-loop** (non-plugin increment): `scripts/dev-loop.mjs` orchestrating fresh headless agent phases per increment (worker → gates → independent review → fixer → merge), `STATUS:` protocol in HANDOFF, prompt templates, `--dry-run`. Spec: `docs/superpowers/specs/2026-09-10-dev-loop-design.md`. Evidence: 39 new unit tests across `tests/dev-loop-{status,phases,gates,loop}.test.mjs` (120 total) + `node tests/smoke-l1.mjs` (no-agent dry-run green on the branch: status/prototype/tests/smokes gates PASS, context-dependent gates SKIPPED); the prototype-absent gate caught a live re-registration of the prior prototype mid-increment. Merging stayed human for L1 itself (`--dogfood on` refuses to run before then); `--merge auto` arrives with L2. | I2 |
| L2 | ✅ Done (PR #9) | **autopilot merge mode** (non-plugin increment): `--merge human\|auto` on the dev-loop — the loop itself squash-merges the increment PR when gates are green, all active reviews are clean, and the reviewed head is unchanged (headRefOid recorded at assessment, re-fetched and pinned immediately before `gh pr merge`; a moved head re-enters assessment once, a second move stops); merging stays loop-owned and code-governed, never agent-discretion. Default human, auto always an explicit flag; pre-I3 auto = explicit opt-in on the independent review alone; from I3, auto additionally requires the dogfood review (enforced by I3's wiring). The assessment path also ff-only-syncs the PR branch to origin so gates/reviews test the exact head the pin records. Evidence: 135 unit tests (`node --test tests/*.test.mjs`, incl. the merge-mode matrix: auto+dogfood-off merges with post-merge gates; human stops at awaiting-human-merge (default and with dogfood on); auto never merges on blocking findings, fatal review stops, exhausted fixer budget, unknown/unpinnable head, or a twice-moved head; plus `gateBranchHead` fake-run coverage of the checkout → ff-only-sync → rev-parse==headRefOid wiring) + `node tests/smoke-i1.mjs` + `node tests/smoke-i2.mjs` + `node tests/smoke-l1.mjs` (dry-run green with `--merge auto`, header surfaced). Fresh-eyes review (no prior context): approve-with-nits — its P1 (head-establishment wiring inline and untested in the CLI entry) fixed by extracting `gateBranchHead` into gates.mjs with tests; P2s taken: precise no-valid-headRefOid message, shared `isFullOid` validator on both ends of the pin, smoke-l1 exercising the positive `--merge auto` path; the disclosed scope-addition P2 was already flagged in the PR and endorsed as-is. Merging of L2's own PR stayed human (the flag didn't exist until it landed). | L1 |
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

- **2026-09-10 (L2)** — autopilot merge mode landed (PR #9): `--merge human|auto`
  (default human, explicit value required, exit 2 otherwise) decoupled merging from
  the dogfood flag — the loop now merges in `auto` mode on green gates + clean
  active reviews, with the merge decision code-owned in `runLoop` exactly like the
  gates. Head pinning per the amended spec: the assessment records the PR
  `headRefOid` (surfaced through the increment-pr gate/wiring), the loop re-fetches
  it immediately before `gh pr merge` (40-hex-validated, fail-closed on gh errors),
  a moved head re-enters assessment once and a second move stops rather than
  merging unreviewed commits. Implementation note: because the reviewer and gates
  run against the local checkout while the pin compares remote OIDs, the assessment
  path now checkout+ff-only-syncs the PR branch to origin — without that, a moved
  head would be tested and reviewed against a stale tree. Workers/reviewer/fixer
  remain merge-denied (`--disallowed-tools` + prompts); `--dogfood on` still refuses
  to run pre-I3; `auto⇒dogfood` enforcement is I3's obligation. Tests: merge-mode
  matrix in `tests/dev-loop-loop.test.mjs` + CLI exit-2 micro-tests in
  `tests/dev-loop-cli.test.mjs` + `gateBranchHead` fake-run tests (122 → 135). The
  fresh-eyes review round (approve-with-nits) drove the P1 fix: the head-establishment
  wiring left inline in the CLI entry was extracted into `gateBranchHead`
  (gates.mjs) and covered; P2s folded in (precise no-head message, shared `isFullOid`
  on both pin ends, smoke-l1 runs `--dry-run --merge auto`). No new runtime facts; no
  spec changes (implemented the already-amended design as-is).

- **2026-09-10 (autopilot merge design)** — Approved in conversation: **L2 (autopilot
  merge mode)** inserted between L1 and I3. `--merge human|auto`, default **human**
  and always an explicit flag (no silent default flips): `auto` is the *loop*
  merging under code-owned conditions (green gates + clean active reviews + resolved
  fixer), never an agent-discretion merge — same authority-path rule the plugin
  applies to publication. Pre-I3 `auto` opts into single-review merging (bounded:
  squash-revertible, post-merge main-green stops on red); post-I3 `auto` requires
  the dogfood review (I3 enforces). Spec amended (merge-policy row, architecture
  step 7, guardrails, CLI, sequencing + Amendments section); HANDOFF targets L2.

- **2026-09-10 (L1)** — dev-loop landed (PR #7): `STATUS:` parsing + ROADMAP eligibility,
  process runner with SIGTERM→SIGKILL timeouts and zcode arg builders (merge denied via
  `--disallowed-tools`), deterministic gates (repo-idle, prototype-absent, tests, smokes,
  increment-pr, docs-updated, main-green), the iteration state machine (dual review, ≤2
  shared fixer rounds, invocation failures fatal), the CLI entry with `--dry-run` +
  `.dev-loop/` reports (gitignored), and the three prompt templates; `STATUS:` protocol
  introduced in HANDOFF. Plan-vs-tree drift was reconciled and flagged in the PR (7
  plan-code/test corrections, incl. dry-run exit code, worked-increment capture for
  docs-updated, loop iteration accounting, machine-dependent CLI-resolution test, and the
  I2 shared smoke-harness being excluded from smoke enumeration). Runtime facts: the prior
  `copilot-pr-review` prototype re-registered itself mid-session (I1 hazard is real and
  recurring) — the prototype-absent gate caught it and the documented uninstall fixed it;
  `smoke-l1` is a script smoke with no Copilot SDK dispatch, so it does not use the SDK
  harness (AGENTS.md wording updated).

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
