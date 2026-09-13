# HANDOFF.md — instructions for the next session

STATUS: next=I7

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

## Recorded state (2026-09-13, after I6)

- `main` = I6 complete (selection and retention), assuming the I6 PR merges.
  Working tree clean. No open PRs should remain.
- **Version is 0.2.3** (I6 was additive). Every merged increment bumps `plugin.json` —
  pre-1.0: additive → patch, breaking → minor — enforced by the dev-loop `version-bump`
  gate; the loop's merge path auto-tags `vX.Y.Z`. Never push a tag from a branch.
- **Selection and retention are live:** a review's findings are numbered in the
  report; the review is retained in-session with a default selection of all validated
  findings. `/z-pr-review select all|none|<numbers, e.g. 1,3-5>` settles or re-settles
  the selection (pure code over the retained state; bad specs refused precisely);
  `--all` on the review invocation settles it at review time; `/z-pr-review inspect`
  renders the retained settled result — frozen binding, coverage/status, per-finding
  selected/not-selected marks — with no model calls and no GitHub access. Elicitation
  is the chat follow-up turn (the Copilot SDK has no verified interactive-prompt API
  for command handlers; flagged in the I6 PR against the spec's "native elicitation").
  Publication of the selected findings is I7's job; `select none` deselects without
  deleting (findings stay visible in `inspect`).
- Reviews otherwise work as in I5/C1: `/z-pr-review N
  [--quick|--balanced|--full|--deep] [--no-comment] [--all]`; batch `partial`/`failed`
  and `degraded` block the dogfood merge (fail-closed).
- **After I6:** I7 — gated COMMENT publication (single POST, ≤50 validated inline
  anchors, idempotency marker, stale/draft/self gates, uncertain-write
  reconciliation; `--comment` / `autoPostReviews`). Bump reminder for I7's worker:
  additive → `0.2.4`.
- **Attribution state:** I3–I6 are original code; `docs/ATTRIBUTION.md` lists no
  reused modules. The upstream LICENSE issue (10ego/pi-pr-review#150) stays open as a
  standing record.
- **Calibration owed:** the balanced batch (5 lanes, 12m batch cap) + one
  adjudicator call (60s default) vs `PHASE_LIMITS.dogfood` (20m) — adjust from
  observed loop timings (`.dev-loop` reports carry `phaseTimings`).
- zcode headless auth remains `ZAI_API_KEY` env + keyless `~/.zcode/cli/config.json`;
  the `zcode-headless` preflight gate fails fast if that regresses. zcode 0.16.5
  still rejects `--max-turns`/`--settings` at parse time.
- Tests: `node --test tests/*.test.mjs` (353). Smokes: `tests/smoke-i1.mjs`
  (SDK dispatch, no inference; now also exercises the select/inspect surface),
  `tests/smoke-i2.mjs` (SDK dispatch, no inference), `tests/smoke-i3.mjs`
  (SDK dispatch; the lane children and the adjudicator perform real inference BY
  DESIGN — parent session stays inference-free; scenario skips cleanly when no PR
  is open; full 5-lane balanced batch + adjudication by default — budget ~13m),
  `tests/smoke-l1.mjs` (script smoke: dev-loop `--dry-run` with
  `--merge auto --dogfood on`; allow a few minutes). All must pass before merge.
  NOTE: run smokes from a shell with the real `HOME` (or `COPILOT_SDK_PATH` set) —
  the harness resolves the bundled SDK from `~/.copilot/pkg`.

## Next increment: I7 — gated COMMENT publication

Publication of the selected findings as one gated COMMENT review POST:
`--comment` or `autoPostReviews` as the only authority (captured before lanes
start); stale-head check, draft/lifecycle, self-author gates; inline anchors
for the first 50 findings whose anchors validate against `pulls/N/files`
hunks, remainder to `Other Notes`; idempotency marker; no validated findings →
no POST; uncertain write response → reconcile by scanning existing reviews for
the marker. See the I7 ROADMAP row and the spec's "Publication gates" section.
The I6 retained result is the publication input — the settled selection
selects what posts. Bump `plugin.json` to `0.2.4` (additive, expected).

Dogfood runs from I3 onward: every increment PR (including I7's) is reviewed by
this tool via the dev-loop before merge. Never merge your own PR — the loop
(`node scripts/dev-loop.mjs --merge auto --dogfood on`, launched by the user from a
shell where `ZAI_API_KEY` is set) or the human owns merging.
