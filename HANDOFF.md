# HANDOFF.md — instructions for the next session

STATUS: next=I6

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
parses and validates it. Keep it directly under the H1 title. The grammar accepts
`I`/`L`/`V`/`C` ids since I4 (PR #18).

## Recorded state (2026-09-12, after I5)

- `main` = I5 complete (validation and adjudication), assuming the I5 PR merges.
  Working tree clean. No open PRs should remain.
- **Version is 0.2.2** (I5 was additive). Every merged increment bumps `plugin.json` —
  pre-1.0: additive → patch, breaking → minor — enforced by the dev-loop `version-bump`
  gate; the loop's merge path auto-tags `vX.Y.Z`. Never push a tag from a branch (the
  C1 `v0.2.1` collision lesson, 2026-09-12).
- **Validation and adjudication are live:** every review now captures the batch's
  candidates, host-validates them against the captured diff (anchors: touched file +
  new-side hunk range for lines; evidence = non-empty detail required for P0/P1),
  runs ONE isolated adjudicator call (heavy tier via the `runLane` machinery with a
  prompt override, envelope contract, `deadlines.adjudicationMs` clipped to the
  remaining total budget), re-validates its output (ladder, sources shape, anchors;
  unknown `sources` lane ids stripped), dedups (file+line+normalized title), and
  applies the per-mode findings policy in code (quick: P0–P2; balanced: P0–P2 + ≤3
  diff-anchored P3/nit; full/deep/custom: all). A failed/malformed/budget-expired
  adjudication degrades to the validated candidates with review status `degraded` —
  never clean; partial batches still synthesize completed lanes' findings with
  `status: partial`. The machine-summary field shape is exactly as before (protocol
  surface; `degraded` is a new status VALUE that blocks the dogfood merge
  fail-closed). Custom-role findings flow through the identical gates — prompts
  never gain authority.
- **I5 landed unusually** (see the ROADMAP I5 journey entries): the worker session
  had no shell tool, so the supervisor session verified its change set, fixed one
  disclosure defect its own new tests caught, and opened the PR per its handoff.
- **After I5:** I6 — selection and retention (elicitation-based finding selection
  `--all`/subset/none, retained settled result inspectable without inference).
  Bump reminder for I6's worker: additive → `0.2.3`.
- Reviews otherwise work as in C1: `/z-pr-review N
  [--quick|--balanced|--full|--deep] [--no-comment]`; batch `partial`/`failed` and
  now `degraded` block the dogfood merge (fail-closed).
- **Attribution state:** I3–I5 are original code; `docs/ATTRIBUTION.md` lists no
  reused modules (upstream's Step-7 validation methodology informed I5; no source
  copied). The upstream LICENSE issue (10ego/pi-pr-review#150) stays open as a
  standing record.
- **Calibration owed:** the balanced batch (5 lanes, 12m batch cap) + one
  adjudicator call (60s default) vs `PHASE_LIMITS.dogfood` (20m) — adjust from
  observed loop timings (`.dev-loop` reports carry `phaseTimings`); also settle
  the zcode completion signal if still open (dev-loop spec open items 1–3).
- **Known weak signal:** the I5 worker phase exited 0 having completed only the
  file-edit steps (its session had no shell tool — its own report, consistent with
  the unbranched/uncommitted tree it left). The `zcode-headless` preflight probe is
  a text-only turn, so it cannot catch a phase whose toolset is degraded; if a
  future worker also lands "implemented but unlanded", check the phase toolset
  before re-dispatching (a loop-side probe that exercises a tool call is a
  candidate hardening PR).
- zcode headless auth remains `ZAI_API_KEY` env + keyless `~/.zcode/cli/config.json`;
  the `zcode-headless` preflight gate fails fast if that regresses. zcode 0.16.5
  still rejects `--max-turns`/`--settings` at parse time.
- Tests: `node --test tests/*.test.mjs` (330). Smokes: `tests/smoke-i1.mjs`,
  `tests/smoke-i2.mjs` (SDK dispatch, no inference), `tests/smoke-i3.mjs` (SDK
  dispatch; the lane children and now the adjudicator perform real inference BY
  DESIGN — parent session stays inference-free; scenario skips cleanly when no PR
  is open; full 5-lane balanced batch + adjudication by default — budget ~13m),
  `tests/smoke-l1.mjs` (script smoke: dev-loop `--dry-run` with
  `--merge auto --dogfood on`; allow a few minutes). All must pass before merge.
  NOTE: run smokes from a shell with the real `HOME` (or `COPILOT_SDK_PATH` set) —
  the harness resolves the bundled SDK from `~/.copilot/pkg`.

## Next increment: I6 — selection and retention

Elicitation-based finding selection (`--all`, subset, none) over I5's assembled
findings, and the retained settled result inspectable without inference or GitHub
access. See the I6 ROADMAP row and the spec's "Review pipeline" (selection /
retention) sections. Bump `plugin.json` to `0.2.3` (additive, expected).

Dogfood runs from I3 onward: every increment PR (including I6's) is reviewed by
this tool via the dev-loop before merge. Never merge your own PR — the loop
(`node scripts/dev-loop.mjs --merge auto --dogfood on`, launched by the user from a
shell where `ZAI_API_KEY` is set) or the human owns merging.
