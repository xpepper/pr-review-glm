# HANDOFF.md — instructions for the next session

STATUS: next=I8

Written for a **fresh session** continuing this project. This file is rewritten at
the end of every increment; it is the single source of "where we stopped".

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

## Recorded state (2026-09-13, after I7)

- `main` = I7 complete (gated COMMENT publication), assuming the I7 PR merges.
  Working tree clean. No open PRs should remain.
- **Version is 0.2.4** (I7 was additive). Every merged increment bumps `plugin.json` —
  pre-1.0: additive → patch, breaking → minor — enforced by the dev-loop `version-bump`
  gate; the loop's merge path auto-tags `vX.Y.Z`. Never push a tag from a branch.
- **Publication is live:** `/z-pr-review N --comment` (or config `autoPostReviews`,
  unless `--no-comment`) publishes the retained settled selection as ONE gated COMMENT
  review after the in-chat report — draft/closed/self-author refusals, stale head →
  body-only naming both commits, ≤50 inline anchors re-validated against
  `pulls/N/files` hunks (remainder to body notes), idempotency marker, final head
  re-check, uncertain-write reconciliation; all code-owned, fail-closed, sanitized
  model text. `select`/`inspect` do not publish (`/z-pr-review publish` on the
  retained result is post-v1 backlog).
- Reviews otherwise work as in I6: `/z-pr-review N
  [--quick|--balanced|--full|--deep] [--comment|--no-comment] [--all]`; batch
  `partial`/`failed` and `degraded` block the dogfood merge (fail-closed); the I6
  review P2s (leading-zero specs, bounds-before-expansion, control-sequence
  stripping, retained-staleness disclosure) are folded into I7.
- **After I7:** I8 — hardening: large-diff file-backed transport (≥200 KB manifest +
  required read ranges), lane/credit telemetry from runtime events, dogfood-driven
  fixes; `1.0.0` when I8 completes. Bump reminder for I8's worker: additive → `0.2.5`.
- **Attribution state:** I3–I7 are original code; `docs/ATTRIBUTION.md` lists no
  reused modules. The upstream LICENSE issue (10ego/pi-pr-review#150) stays open as a
  standing record.
- **Calibration owed:** the balanced batch (5 lanes, 12m batch cap) + one
  adjudicator call (60s default) vs `PHASE_LIMITS.dogfood` (20m) — adjust from
  observed loop timings (`.dev-loop` reports carry `phaseTimings`).
- zcode headless auth remains `ZAI_API_KEY` env + keyless `~/.zcode/cli/config.json`;
  the `zcode-headless` preflight gate fails fast if that regresses. zcode 0.16.5
  still rejects `--max-turns`/`--settings` at parse time.
- Tests: `node --test tests/*.test.mjs` (408). Smokes: `tests/smoke-i1.mjs`
  (SDK dispatch, no inference; exercises the select/inspect surface and asserts the
  status `Version:` line against plugin.json), `tests/smoke-i2.mjs`
  (SDK dispatch, no inference), `tests/smoke-i3.mjs` (SDK dispatch; the lane
  children and the adjudicator perform real inference BY DESIGN — parent session
  stays inference-free; scenario skips cleanly when no PR is open; full 5-lane
  balanced batch + adjudication by default — budget ~13m), `tests/smoke-l1.mjs`
  (script smoke: dev-loop `--dry-run` with `--merge auto --dogfood on`; allow a few
  minutes). All must pass before merge. NOTE: run smokes from a shell with the real
  `HOME` (or `COPILOT_SDK_PATH` set) — the harness resolves the bundled SDK from
  `~/.copilot/pkg`.

## Next increment: I8 — hardening

Large-diff file-backed transport: diffs ≥200,000 bytes switch to a changed-file
manifest plus required read ranges (ported from upstream's
`pr-review-context`/artifact logic — attribution in `docs/ATTRIBUTION.md` if
code is reused); completeness enforced from tool events. Lane/credit telemetry
from runtime events (`session.usage_checkpoint` etc.). Dogfood-driven fixes from
the accumulated review rounds. See the I8 ROADMAP row and the spec's "capture.mjs"
component plus "Degradation and budgets". `1.0.0` lands when I8 completes.
Bump `plugin.json` to `0.2.5` if additive (expected).

Dogfood runs from I3 onward: every increment PR (including I8's) is reviewed by
this tool via the dev-loop before merge. Never merge your own PR — the loop
(`node scripts/dev-loop.mjs --merge auto --dogfood on`, launched by the user from a
shell where `ZAI_API_KEY` is set) or the human owns merging.
