# HANDOFF.md — instructions for the next session

STATUS: next=L2

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

## Recorded state (2026-09-10, after L1 + autopilot design prep)

- `main` = L1 complete (dev-loop, PR #7) + autopilot-merge design docs, assuming the
  prep PR merges. Working tree clean. No open PRs should remain.
- L1 shipped (non-plugin): `scripts/dev-loop.mjs` + `scripts/dev-loop/` modules
  (`status`/`phases`/`gates`/`loop`), prompt templates, `.dev-loop/` reports
  (gitignored), `tests/smoke-l1.mjs`. Suite: 122 unit tests + smoke-i1/i2/l1 green.
  Plan-vs-tree drift was flagged in PR #7's description — read it before touching the
  loop code; its review round fixed 4 P1s (final-increment `STATUS: done` acceptance,
  no-PR fail-fast, review-file invalidation, branch checkout before gates).
- **Autopilot merge mode was designed and approved in conversation (2026-09-10)** —
  the spec is already amended (merge-policy row, architecture step 7, guardrails,
  CLI, sequencing, and an Amendments section documenting the change); ROADMAP carries
  the L2 row. Settled design, do not reopen:
  - `--merge human|auto`, default **human**, always an explicit flag — no silent
    default flips later.
  - `auto` = the **loop** merging under code-owned conditions (green gates + all
    active reviews clean + fixer resolved + **unchanged reviewed head**) → then
    post-merge gates (main-green, stop-on-red). Never an agent-discretion merge;
    workers/reviewer/fixer stay merge-denied (`--disallowed-tools`, prompts).
  - Pre-I3, `auto` merges on the independent review alone (explicit opt-in, bounded:
    squash-revertible, no force pushes, main-green catch). Once dogfood exists, `auto`
    additionally requires `--dogfood on` — **enforcement is I3's obligation, not L2's**.
- Runtime fact confirmed live: the prior `copilot-pr-review` prototype re-registered
  itself during the L1 session (I1 hazard recurs). The prototype-absent gate caught
  it; remedy remains `copilot plugin uninstall copilot-pr-review`.
- Tests: `node --test tests/*.test.mjs` (122). Smokes: `tests/smoke-i1.mjs`,
  `tests/smoke-i2.mjs` (SDK dispatch, share `tests/smoke-harness.mjs`),
  `tests/smoke-l1.mjs` (script smoke: dev-loop `--dry-run`; transitively runs the
  full suite + both SDK smokes — allow a few minutes). All must pass before merge.

## Next increment: L2 — autopilot merge mode (non-plugin)

Implement what the amended spec settles (above). Definition of done:

- `scripts/dev-loop.mjs`: parse/validate `--merge human|auto` like `--dogfood on|off`
  (explicit value required; missing/invalid → exit 2); default `human`; usage string
  updated; pass `mergeMode` into the loop wiring.
- `scripts/dev-loop/loop.mjs`: new injected `mergeMode` dep (default `"human"`).
  With `auto`, a clean assessment proceeds to merge + post-merge gates exactly like
  today's dogfood-on path (pre-I3 that means independent review only). With `human`,
  today's `awaiting-human-merge` stop is unchanged (including when `--dogfood on`,
  which pre-I3 still refuses to run entirely).
- **Head pinning (spec, architecture step 7):** record the PR `headRefOid` at
  assessment time (extend the increment-pr gate/wiring to surface it) and re-fetch it
  immediately before `gh pr merge`; a moved head re-enters assessment instead of
  merging unreviewed commits (the I2 capture head-moved re-check pattern).
- Tests (`tests/dev-loop-loop.test.mjs`): merge-mode matrix — `auto` + dogfood off
  merges and runs post-merge gates; `human` stops at awaiting-human-merge; `auto`
  still never merges on blocking findings, fatal stops, exhausted fixer budget, or a
  moved head. Keep all existing loop tests green (they default to `human` semantics
  → the awaiting-human-merge case stays the default-path assertion).
- Optional nicety, not required: surface the configured merge mode in the dry-run
  header line.
- NOT in scope: dogfood wiring or `auto⇒dogfood` enforcement (I3), any default flips,
  changes under `extensions/`.
- Bookkeeping: ROADMAP L2 row ✅ with real evidence (test counts), journey-log entry,
  rewrite HANDOFF for I3 (`STATUS: next=I3`), AGENTS.md automation note if wording
  drifts.

Boundaries: the full suite + all three smokes green before merge; do not start I3;
follow the per-increment workflow (branch `l2-autopilot-merge`, PR, independent
fresh-eyes review, fix findings, squash merge — the L2 session merges its own PR by
hand, since the flag it builds doesn't exist until it lands).

## After L2: I3 — first minimal review (dogfood entry point)

One heavy lane over the captured diff via a **Copilot SDK child runtime** (owned
`CopilotClient`/`RuntimeConnection`, envelope-marker output contract — structured
output is broken on Copilot CLI 1.0.83), findings parsed and rendered in-chat.
`/pr-review N` becomes a real review command over I2's capture. No tiers (I4), no
validation/adjudication (I5), no publication (I7).

I3 additionally owes the dev-loop: replace the `runDogfood: undefined` stub with the
real SDK-dispatched review (`--no-comment`), map validated P0/P1 findings into the
review-file contract, **enforce `--merge auto` ⇒ `--dogfood on`**, and calibrate
`PHASE_LIMITS` empirically in the supervised first run (spec open items 1–3). For
I3's own supervised run, `--merge human` is recommended (calibrate the loop with
human eyes on the first real merge); from I4, run unattended batches with
`--merge auto --dogfood on`. Run I3 through the dev-loop. The upstream LICENSE issue
(see `docs/ATTRIBUTION.md`) must be filed before I4+ reuse — not needed for I3.

After I3: I4 — topologies and tiers (quick/balanced/full/deep lane sets, tiered
models + fallbacks, concurrent lanes, budgets with cancellation).
