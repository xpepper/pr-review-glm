# HANDOFF.md — instructions for the next session

STATUS: next=I4

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

## Recorded state (2026-09-10, after I3)

- `main` = I3 complete (first review lane + dogfood wiring), assuming PR #15 merges.
  Working tree clean. No open PRs should remain.
- **The plugin reviews for real now:** `/z-pr-review N [--no-comment]` captures the PR
  (I2 path) and runs one heavy lane in an owned Copilot SDK child runtime
  (`extensions/z-pr-review/lane.mjs`). Output contract is envelope markers
  (`<<<REVIEW_BEGIN>>>` … `<<<REVIEW_END>>>`, whole lines only, one whole-response
  fence unwrapped); findings are shaped deterministically (ladder severity + title;
  malformed candidates dropped with disclosure); `renderReview` renders in-chat and
  appends a fenced `z-pr-review-findings` machine-summary block. Mode flags, `--all`,
  and `--comment` are rejected with pointers to I4/I6/I7 — never silently ignored.
  No validation/adjudication (I5), selection (I6), or publication (I7) yet; a failed
  or deadline-exceeded lane is disclosed as an incomplete review, never a clean one.
- **Dev-loop dogfood is live:** `scripts/dev-loop/dogfood.mjs` dispatches the real
  `/z-pr-review <PR> --no-comment` through `tests/smoke-harness.mjs` (shared, not
  forked), asserts at dispatch that our command is registered with OUR description
  (the protection that replaced the removed prototype-absent gate), maps the machine
  summary into the review contract fail-closed (verdict computed in loop code), and
  writes `.dev-loop/review-dogfood.json`. `--merge auto` now requires `--dogfood on`
  (exit 2 at the CLI; `runLoop` also stops before dispatching anything). From I4,
  run unattended batches with:
      node scripts/dev-loop.mjs --merge auto --dogfood on [--max-iterations N]
  launched from a shell where `ZAI_API_KEY` is set (`echo ${ZAI_API_KEY:+set}`).
- **Calibration still owed from the supervised first run:** `PHASE_LIMITS.dogfood`
  (20m) and the lane attempt deadline (config `deadlines.attemptMs.heavy`, 12m
  default) are starting guesses — adjust from observed timings, and settle the zcode
  completion signal if still open (spec open items 1–3).
- zcode headless auth remains `ZAI_API_KEY` env + keyless `~/.zcode/cli/config.json`;
  the `zcode-headless` preflight gate fails fast if that regresses. zcode 0.16.5
  still rejects `--max-turns`/`--settings` at parse time.
- Tests: `node --test tests/*.test.mjs` (163). Smokes: `tests/smoke-i1.mjs`,
  `tests/smoke-i2.mjs` (SDK dispatch, no inference), `tests/smoke-i3.mjs` (SDK
  dispatch; the lane child performs real inference BY DESIGN — parent session stays
  inference-free; scenario skips cleanly when no PR is open), `tests/smoke-l1.mjs`
  (script smoke: dev-loop `--dry-run`; transitively runs everything — allow a few
  minutes). All must pass before merge. smoke-l1 runs the dry-run with
  `--merge auto --dogfood on` (the only combination auto allows since I3) and
  therefore transitively exercises smoke-i3's real lane review when a PR is
  open — budget the time and the model call.
- The upstream LICENSE issue (see `docs/ATTRIBUTION.md`) **must be filed before I4+**
  reuse of upstream `lib/` — I4 is the first increment that would port upstream
  logic (tier fallbacks/topologies); do not port without it.

## Next increment: I4 — topologies and tiers

Quick/balanced/full/deep mode topologies over the I3 lane machinery: lane sets per
mode (spec "Review pipeline" table), light/medium/heavy models + one fallback each
from config, concurrent lanes with per-lane progress (`session.log`), attempt/total
budgets with cancellation propagation. The `--quick|--balanced|--full|--deep` flags
are already parsed and currently rejected — flip them live. Dogfood runs from here on:
every I4+ increment PR is reviewed by this tool via the dev-loop before merge.

After I4: C-series STATUS-id support (`next=C1` currently fails the status gate —
extend the grammar in a code PR before C1 becomes active), then C1 (custom review
roles) or I5 per ROADMAP order.
