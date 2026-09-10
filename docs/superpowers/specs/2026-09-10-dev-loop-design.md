# Design: dev-loop — a script-orchestrated increment loop

Date: 2026-09-10
Status: approved in conversation; pending user review (this PR)
Repo: `pr-review-glm` → https://github.com/xpepper/pr-review-glm

## Context and goal

The per-increment workflow is repetitive and already a state machine: read the prompt
state in `HANDOFF.md` → work the next ROADMAP increment → open a PR → review it →
update docs → merge → rewrite `HANDOFF.md` for the next session. This design automates
the *session boundary*, not the work: a deterministic script orchestrates a sequence of
fresh headless agent invocations, one phase per judgment task, with code-owned gates
between them. The human leaves the loop; branch protection and the gates stay.

The loop is dev tooling for this repository, not a plugin increment, and lands via the
normal PR flow itself.

## Settled decisions (from the 2026-09-10 design conversation)

| Decision | Choice |
|---|---|
| Orchestrator | Script loop (`scripts/dev-loop.mjs`, plain ESM, no deps), not an in-session agent. Deterministic shell owns sequencing and gates; every judgment phase is a fresh headless agent invocation. |
| Worker | `zcode` CLI headless: `zcode --prompt <text> --cwd <repo> --mode yolo`, with merge denied via `--disallowed-tools` (zcode 0.16.5 parser-rejects `--max-turns` while still listing it in `--help`; phase bounds are wall-clock — see Amendments). Binary resolved from `ZCODE_CLI` env, default the app-bundle path (version-sensitive; flagged below). |
| Merge policy | Merging is loop-owned and code-governed (`gh pr merge --squash --delete-branch`), never agent-discretion. `--merge human\|auto` (default **human**): `auto` merges only when gates are green **and all active reviews are clean** — (1) an independent reviewer invocation always, (2) the plugin's own dogfood review once it exists (I3+), which `auto` then additionally requires. Pre-I3, `auto` is an explicit opt-in on the independent review alone; `human` stops the loop after review 1 + gates and leaves merging to the human. |
| Clean | A review is clean when it reports no P0/P1 findings. P2 nits are recorded on the PR and do not block. |
| State protocol | A machine-owned `STATUS:` line in `HANDOFF.md` (first line matching `^STATUS: `): `next=<increment-id>` · `blocked: <one-line reason>` · `done`. The worker writes it when rewriting HANDOFF; the loop only parses and validates it. |
| Worker permissions | `--mode yolo` (headless default) minus merge. Start permissive-but-mergeless rather than pre-narrowed; tighten after the first supervised runs. |
| Guardrails | `--max-iterations` default **1**; cooldown between iterations; `--dry-run`; `--merge` default **human** (auto is always an explicit flag); bounded fixer budget (≤2 rounds per iteration, shared across gates and reviews); stop on any failure with a report, state left inspectable. The loop never force-pushes and never commits to `main` directly. |
| ROADMAP amendment | One non-plugin increment, **L1 (dev-loop)**, lands after I2 and before I3. I3 is the first fully automated increment — and the first the plugin reviews itself. |

## Why a script loop (recorded rationale)

- Fresh context per increment is a design constraint the project already chose; a script
  guarantees it, an in-session orchestrator accumulates context rot over 7+ increments.
- The between-increment gate must be deterministic code, not a model's claim of success —
  the same host-validated principle the plugin itself is built on, applied to the
  meta-workflow. (The I1 session proved this matters: the independent review found real
  gaps the worker hadn't self-reported.)
- The loop is worker-agnostic (any agent CLI) and crash-safe: iteration state lives in
  git; a dying iteration does not kill the pipeline.
- What is bought is unattended seriality, not speed: reviews still take their time.

## Architecture — one iteration

1. **Preflight** (shell): `main` clean and synced with `origin/main`; no open PRs; the
   prior `copilot-pr-review` prototype has not re-registered (the I1 caveat; check
   `copilot plugins list`); unit tests + smoke green on `main`.
2. **Worker** (one fresh headless invocation, prompt from
   `scripts/dev-loop/worker-prompt.md` with `{INCREMENT}` substituted from `STATUS`):
   the standard increment prompt — read AGENTS/HANDOFF/ROADMAP/spec, verify state, one
   increment, evidence, docs, PR. The worker never merges (prompt + tool denial).
3. **Gates** (shell, zero trust in worker claims): exactly one open PR for the increment
   branch; `node --test tests/*.test.mjs` green on the branch; the applicable smoke
   script green; ROADMAP row ✅ with evidence; `HANDOFF.md` rewritten with a valid,
   advanced `STATUS:` line.
4. **Review 1 — independent reviewer** (fresh headless invocation, review-only prompt
   from `scripts/dev-loop/reviewer-prompt.md`, read access + PR comment): verdict
   (approve / approve-with-nits / request-changes) + findings P0–P2. P0/P1 are blocking.
5. **Review 2 — dogfood** (from I3; `--dogfood on`): the plugin reviews its own
   increment PR via the SDK-dispatch harness (the `tests/smoke-i1.mjs` pattern),
   `--no-comment`; validated P0/P1 findings are blocking. The concrete invocation is
   defined by I3's interface; until then the flag is off.
6. **Fixer** (fresh invocation, `scripts/dev-loop/fixer-prompt.md` + findings): runs
   when any gate or review fails; each round is one fixer invocation followed by re-gates
   and re-reviews. Budget: ≤2 rounds per iteration, shared. Exhausted → stop with all
   reports attached to the PR.
7. **Merge** (`--merge auto` only): squash + delete branch, when gates green and all
   active reviews clean — pre-I3 that is the independent review alone (explicit
   opt-in); once the dogfood reviewer exists, `auto` additionally requires it. The
   merge **pins the reviewed head**: re-fetch the PR `headRefOid` immediately before
   `gh pr merge` and, if it moved since assessment, re-enter assessment instead of
   merging unreviewed commits (the I2 capture head-moved re-check pattern). With
   `--merge human` (the default), stop here and leave merging to the human.
8. **Post-merge** (shell): sync `main`; re-run unit tests + smoke on merged `main`;
   red → stop immediately and report (human decides revert vs fix-forward); cooldown;
   next iteration from the new `STATUS:`.

## Components

- `scripts/dev-loop.mjs` — the loop: state parsing, invocation, gates, merge, report.
  CLI: `node scripts/dev-loop.mjs [--max-iterations N] [--cooldown-seconds S]
  [--dry-run] [--dogfood on|off] [--merge human|auto]` (`--dogfood` defaults to off,
  I3 turns it on; `--merge` defaults to human and `auto` is always explicit).
  Env: `ZCODE_CLI`, `GH_REPO` (default from origin).
- `scripts/dev-loop/worker-prompt.md` — the standard increment prompt, `{INCREMENT}`
  placeholder. Derived from the prompt used for I1 (read-first, one increment, evidence,
  docs, PR, no merge, don't reopen settled decisions, flag don't decide silently).
- `scripts/dev-loop/reviewer-prompt.md` — review-only prompt for the independent
  reviewer (derived from the I1 review pass: scope check, correctness, conventions,
  empirical test run, P0/P1/P2 verdict format).
- `scripts/dev-loop/fixer-prompt.md` — receives the failing gates/findings, fixes on the
  increment branch, re-runs tests/smoke.
- `STATUS:` protocol in `HANDOFF.md` — `next=<id>` (must match a ROADMAP increment not
  yet ✅), `blocked: <reason>` (loop halts), `done` (all increments ✅).

## Error handling

- Worker invocation fails or times out (wall-clock caps per phase) → stop; any PR it
  opened stays open for the human.
- Any gate or review failure → fixer round; budget exhausted → stop with reports on the
  PR. The loop never retries a phase unboundedly.
- Malformed/missing/`blocked` `STATUS:` → stop before dispatching anything.
- Post-merge `main` red → stop and report; never auto-revert.
- The loop never force-pushes, never merges a review it cannot verify, and never
  progresses past a stop condition without a human.

## Testing the loop itself

- `--dry-run` runs every gate exercisable against the current repo state (preflight,
  tests, smoke, `STATUS` parsing, ROADMAP consistency) without invoking any agent, and
  prints what it could not exercise (e.g. "one open PR" with none open).
- First real run is supervised (a human watches one full iteration, `--max-iterations 1`).
  L1 landed dry-run-only, so that supervised run is the I3 iteration, with
  `--merge human` recommended (from L2 the operator may opt into `--merge auto`);
  the loop's own PRs are reviewed conventionally while pre-I3.
- Defaults are conservative: one iteration per invocation until the user opts into
  batches.

## Sequencing

L1 lands after I2, before I3. I3's dependency becomes I2 + L1 (soft: the plugin work
does not depend on the loop, the automation does). **L2 (autopilot merge mode)** lands
between L1 and I3 so the supervised first real run can already exercise loop-owned
merging if the operator opts in. From I3 on, every increment runs through the loop
with both reviews active — the loop and the dogfood reviewer mature together; from I4
the operator can run unattended batches (`--merge auto --dogfood on`).

## Out of scope (explicit)

Parallel increments · cross-repo generality · hosting the loop anywhere but this
machine (no CI/GitHub Actions) · auto-merging without reviews, ever · the loop editing
ROADMAP beyond what the worker does · moving the loop into the plugin as a command ·
automatic ROADMAP re-planning.

## Open items (resolve during L1, empirically)

1. Headless `zcode --prompt` behavior: unattended git push / `gh pr create` in yolo
   mode; exit-code / `--json` completion signal (gates are the real truth either way).
2. `ZCODE_CLI` path stability across app auto-updates; add a `doctor`-style resolution
   with a clear error when the binary moves. Partially resolved (PR #10): the
   `zcode-headless` preflight gate probes the worker invocation before dispatch;
   the bare-binary resolution error remains as designed.
3. Wall-clock defaults per phase, calibrated in the supervised run (worker,
   reviewer, fixer differ by an order of magnitude). `--max-turns` is
   parser-rejected by zcode 0.16.5 (see Amendments); `PHASE_LIMITS.maxTurns` stays
   as calibration data until a CLI release re-accepts a turn bound.
4. The dogfood review invocation contract (flags, output parsing) — fixed by I3's
   implementation; LOOP lands the harness with the flag off.

## Amendments

- **2026-09-10 (zcode 0.16.5 first-run facts, PR #10):** the first real loop run
  failed in the worker phase — the 0.16.5 parser rejects `--max-turns` (exit 1 +
  usage dump) while `--help` still lists it; `--settings` is dead the same way.
  The Worker invocation drops `--max-turns` (and never sent `--json`); per-phase
  bounds are the wall-clock timeouts in `PHASE_LIMITS`. A new preflight gate
  (`zcode-headless`) probes the exact worker arg set with one cheap turn so flag
  drift or missing model config/auth fails before any phase is dispatched.
  Runtime fact: standalone headless zcode ignores the running app's OAuth and
  needs its own model config + API key (recipe in AGENTS.md, "Environment facts —
  zcode CLI"); the operator owes that setup before the first real iteration
  (resolved 2026-09-10: pre-existing `ZAI_API_KEY` env var + keyless config,
  verified end-to-end — launch the loop from a shell where the var is set).

- **2026-09-10 (L2 — autopilot merge mode, approved in conversation):** the merge
  policy changed from "human merges until the dogfood reviewer exists" to an explicit
  `--merge human|auto` opt-in (default **human**, always an explicit flag — no silent
  default flips later). Design rule: autopilot is the *loop* merging under code-owned
  conditions (green gates + clean active reviews + resolved fixer + unchanged reviewed
  head); an agent never merges by its own judgment — the same authority-path rule the
  plugin applies to publication. Pre-I3, `auto` merges on the independent review alone
  (explicit opt-in, bounded blast radius: squash-revertible, no force pushes,
  head-SHA pinning, post-merge main-green still stops on red); once the dogfood
  reviewer exists (I3+), `auto` additionally requires it — enforcement lands with
  I3's wiring. Merge-policy row, architecture step 7, guardrails, CLI signature, and
  the Sequencing section above were updated.
