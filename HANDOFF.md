# HANDOFF.md — instructions for the next session

STATUS: next=I3

Written for a **fresh session** continuing this project. This file is rewritten at the
end of every increment; it is the single source of "where we stopped".

Read in order: `AGENTS.md` → this file → `ROADMAP.md` → the
[design spec](docs/superpowers/specs/2026-09-09-copilot-pr-review-port-design.md).
Check `git status`, recent PRs (all merged except none expected), and that local `main`
matches `origin/main` before starting. Do not rely on any prior conversation's context.

The `STATUS:` line above is machine-owned (dev-loop protocol,
[spec](docs/superpowers/specs/2026-09-10-dev-loop-design.md)): the first line matching
`^STATUS: ` in this file is one of `next=<increment-id>` · `blocked: <one-line reason>`
· `done`. The worker writes it when rewriting this file; `scripts/dev-loop.mjs` only
parses and validates it. Keep it directly under the H1 title.

## Recorded state (2026-09-10, end of L1 session)

- `main` = L1 complete (dev-loop), assuming PR #7 merges. Working tree clean. No open
  PRs should remain.
- L1 shipped (non-plugin): `scripts/dev-loop.mjs` (CLI entry: `--max-iterations`
  default 1, `--cooldown-seconds` default 60, `--dry-run`, `--dogfood off` — `on`
  refuses to run until I3 lands the dogfood harness) + `scripts/dev-loop/` modules:
  `status.mjs` (STATUS parsing + ROADMAP eligibility), `phases.mjs` (`runCommand`
  spawn/timeout runner, prompt rendering, zcode arg builders with merge denied via
  `--disallowed-tools "Bash(gh pr merge *)"`), `gates.mjs` (repo-idle,
  prototype-absent, tests, smokes, increment-pr, docs-updated, main-green),
  `loop.mjs` (iteration state machine: invocation failures are fatal, blocking
  findings consume the shared ≤2 fixer rounds), and the worker/reviewer/fixer prompt
  templates. Reports go to `.dev-loop/` (gitignored). Plan-vs-tree drift was
  reconciled and flagged in PR #7's description — read it before touching this code.
- Dev-loop usage: `node scripts/dev-loop.mjs` from the repo root (it uses `process.cwd()`
  as the repo). Real iterations assume **exclusive use of the checkout** (workers branch
  in it). With `--dogfood off` the loop stops at `awaiting-human-merge` after gates +
  independent review are clean; it never merges before I3 turns dogfood on.
- Runtime fact confirmed live: the prior `copilot-pr-review` prototype **re-registered
  itself during the L1 session** (the I1 hazard recurs). The prototype-absent gate
  caught it; remedy remains `copilot plugin uninstall copilot-pr-review` (source
  checkout untouched). Expect to run the dry-run or the gate before trusting smokes.
- Tests: `node --test tests/*.test.mjs` (120 tests; dev-loop suites in
  `tests/dev-loop-*.test.mjs`). Smokes: `node tests/smoke-i1.mjs`,
  `node tests/smoke-i2.mjs` (SDK dispatch, share `tests/smoke-harness.mjs`), and
  `node tests/smoke-l1.mjs` (script smoke: dev-loop `--dry-run`, no SDK, no inference —
  it transitively runs the full suite + both SDK smokes, so allow a few minutes).
  All must pass before any increment merges.
- The upstream LICENSE issue (see `docs/ATTRIBUTION.md`) must be filed before I4+
  reuses upstream `lib/` — not needed for I3.

## Next increment: I3 — first minimal review (dogfood entry point)

One heavy lane over the captured diff via a **Copilot SDK child runtime** (owned
`CopilotClient`/`RuntimeConnection`, envelope-marker output contract — structured
output is broken on Copilot CLI 1.0.83), findings parsed and rendered in-chat.
`/pr-review N` becomes a real review command over I2's capture. Scope guard: no
tiers/topologies (I4), no validation/adjudication (I5), no publication (I7).

Definition of done (from ROADMAP + spec): the lane runs model inference in a child
runtime over the captured PR, emits findings behind envelope markers, code parses and
renders them in-chat; every increment PR from here on is reviewed by this tool before
merge — via the dev-loop.

Dev-loop wiring owed by I3:

- Turn `--dogfood on` from a refusal into the real invocation: replace the
  `runDogfood: undefined` stub in `scripts/dev-loop.mjs` with a phase that runs the
  plugin's review against the increment PR through the SDK-dispatch harness pattern
  (`tests/smoke-i1.mjs`), `--no-comment`, and maps validated P0/P1 findings into the
  review-file contract (`reviewBlocking` in `loop.mjs`).
- Calibrate phase limits empirically in the supervised first run (spec open items 1–3:
  headless completion signal, `ZCODE_CLI` path stability, worker/reviewer/fixer
  turn + wall-clock budgets); defaults live in `PHASE_LIMITS`.

Run I3 through the dev-loop (first automated increment; merging stays human until
dogfood review is active and clean).

## After I3

I4 — topologies and tiers: quick/balanced/full/deep lane sets, light/medium/heavy
models + one fallback each from config, concurrent lanes with per-lane progress,
attempt/total budgets with cancellation (kill-escalation machinery noted in I2 also
lands here). File the upstream LICENSE issue before reusing upstream `lib/`.
