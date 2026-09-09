# HANDOFF.md — instructions for the next session

Written for a **fresh session** continuing this project. This file is rewritten at the
end of every increment; it is the single source of "where we stopped".

Read in order: `AGENTS.md` → this file → `ROADMAP.md` → the
[design spec](docs/superpowers/specs/2026-09-09-copilot-pr-review-port-design.md).
Check `git status`, recent PRs (all merged except none expected), and that local `main`
matches `origin/main` before starting. Do not rely on any prior conversation's context.

## Recorded state (2026-09-10, end of I2 session)

- `main` = I2 complete (read-only PR capture), assuming PR #6 merges. Working tree
  clean. No open PRs should remain.
- I2 shipped: `extensions/pr-review/capture.mjs` (`capturePullRequest`: `gh auth
  status` pre-check → `gh repo view --json nameWithOwner` freezes the repo binding →
  `gh pr view N --json …` + `gh pr diff N` with fail-closed consistency checks and
  draft/closed skip gates → JSON envelope written 0600 into a `pr-review-glm-*`
  mkdtemp dir, diff embedded), full review-flag grammar in `parseReviewArgs`
  (`commands.mjs`), `renderCapture` + capture-aware `renderStatus`, extension wiring
  with session-local `lastCapture`. No lanes, no model calls, no publication.
- Tests: `node --test tests/*.test.mjs` (77 tests; fake-`gh` suite in
  `tests/capture.test.mjs`). Smoke: `node tests/smoke-i1.mjs` and
  `node tests/smoke-i2.mjs` (default target: merged PR #3, exercising the closed-gate
  refusal + capture; `SMOKE_PR_NUMBER=<N> SMOKE_PR_CLOSED=0` targets an open PR).
  Both smokes share `tests/smoke-harness.mjs` (SDK session + `waitForCommands` +
  `runCommand` with the zero-inference assertion) — extend that harness, don't fork
  it. All must pass before any increment merges.
- Before any smoke run, check `copilot plugins list`: the prior `copilot-pr-review`
  prototype must stay uninstalled (same command names → ambiguous dispatch). If it
  reappears, `copilot plugin uninstall copilot-pr-review` again.
- I2 details chosen in-session (flagged in PR #6, not settled by the spec): the
  capture envelope schema (`kind: "pr-review-glm-capture"`, `schemaVersion: 1`,
  diff embedded — I8 swaps ≥200 KB diffs to file-backed transport); concrete
  consistency checks (gh-echoed number must match the request, 40-hex OID shape,
  base ≠ head, state ∈ OPEN/CLOSED/MERGED); `--include-drafts`/`--include-closed`
  skip (not fail) while everything else fails closed; flags inert under
  `--capture-only` (mode/comment/all) are rejected at parse time; per-`gh`-call 30s
  timeout; capture files persist in tmpdir for the session (no GC yet). Capturing
  the gh user identity for the I7 self-author gate was deferred to I7.
- The dev-loop (L1) was approved 2026-09-10: spec
  `docs/superpowers/specs/2026-09-10-dev-loop-design.md`, implementation plan
  `docs/superpowers/plans/2026-09-10-dev-loop-l1.md` (6 TDD tasks, complete code in
  the plan). L1 introduces the `STATUS:` line protocol in this file — it is
  deliberately absent until then.

## Next increment: L1 — dev-loop (non-plugin)

Build `scripts/dev-loop.mjs` per the L1 plan (authoritative for tasks and code):
script-orchestrated increment loop with fresh headless agent phases (worker →
deterministic gates → independent review → fixer → merge), `STATUS:` protocol in
HANDOFF, prompt templates, `--dry-run`. The plan is TDD-ordered; follow it task by
task. It is a non-plugin increment: no changes to `extensions/` expected, but the
full test + smoke suite must still pass.

From I3 onward, increments run through the dev-loop; merging stays human until the
dogfood reviewer exists (I3). **Do not** start I3 in the L1 session.

## After L1

I3 — first minimal review (dogfood entry point): one heavy lane over the captured
diff via a Copilot SDK child runtime with the envelope-marker contract; from here
every increment PR is reviewed by this tool before merge. The upstream LICENSE
issue (see `docs/ATTRIBUTION.md`) must be filed before I4+ reuse — not needed for
I3.
