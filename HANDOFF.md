# HANDOFF.md — instructions for the next session

STATUS: next=V1

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

## Recorded state (2026-09-11, after I4)

- `main` = I4 complete (topologies and tiers), assuming PR #18 merges. Working tree
  clean. No open PRs should remain.
- **The plugin reviews with full topologies now:** `/z-pr-review N
  [--quick|--balanced|--full|--deep] [--no-comment]` captures the PR (I2 path)
  and runs the mode's lane batch concurrently — light/medium/heavy lanes, each
  an owned Copilot SDK child runtime (`extensions/z-pr-review/lane.mjs`), one
  fallback attempt per lane on `tiers.<tier>.fallback`, attempt caps clipped to
  `deadlines.batchMs`/`totalMs`.
  Default mode from config `defaultMode`. Batch status is `complete` only when every
  lane completed; `partial`/`failed` are disclosed and block the dogfood merge
  (fail-closed). Machine summary carries `mode`, per-finding `lane`, and a `lanes`
  array; the dogfood verdict mapping is unchanged. `--all` (I6) and `--comment`
  (I7) are still rejected with pointers. No validation/adjudication (I5), selection
  (I6), or publication (I7) yet.
- **Attribution state:** I4 implemented the topologies as original code informed by
  upstream's *documented* lane ids/objectives — no upstream source was copied, so
  `docs/ATTRIBUTION.md` still lists no reused modules. The upstream LICENSE issue
  (10ego/pi-pr-review#150) stays open as a standing record; if a future increment
  ports actual `lib/` source, record it there (module, version, commit).
- **Calibration owed:** the balanced batch (5 lanes, 12m batch cap) vs
  `PHASE_LIMITS.dogfood` (20m) and per-tier attempt defaults — adjust from observed
  loop timings; also settle the zcode completion signal if still open (dev-loop spec
  open items 1–3).
- zcode headless auth remains `ZAI_API_KEY` env + keyless `~/.zcode/cli/config.json`;
  the `zcode-headless` preflight gate fails fast if that regresses. zcode 0.16.5
  still rejects `--max-turns`/`--settings` at parse time.
- Tests: `node --test tests/*.test.mjs` (177). Smokes: `tests/smoke-i1.mjs`,
  `tests/smoke-i2.mjs` (SDK dispatch, no inference), `tests/smoke-i3.mjs` (SDK
  dispatch; the lane children perform real inference BY DESIGN — parent session
  stays inference-free; scenario skips cleanly when no PR is open; since I4 it runs
  the full 5-lane balanced batch by default — budget ~12m), `tests/smoke-l1.mjs`
  (script smoke: dev-loop `--dry-run`; transitively runs everything — allow a few
  minutes). All must pass before merge. smoke-l1 runs the dry-run with
  `--merge auto --dogfood on` and therefore transitively exercises smoke-i3's real
  lane review when a PR is open — budget the time and the model calls.

## Next increment: V1 — plugin release versioning

Small, user-requested (2026-09-11; see the V1 ROADMAP row and its journey entry).
The plugin follows semver so a user can tell which release they are running:
`plugin.json` `version` (stale at `0.1.0` since I1; already surfaced by
`copilot plugin list`) bumped semantically per merged release, the squash merge
tagged `vX.Y.Z` on `main`, and the running version reported by `/z-pr-review status`.
Pre-1.0 (`0.x.y`) while increments land — breaking moves the minor, additive the
patch — with `1.0.0` when the v1 scope (I8) completes. The exact bump gate (every
increment vs behavior-affecting changes only) and whether the dev-loop enforces the
bump as a gate are decided when V1 is designed — confirm boundaries if ambiguous.
The `STATUS:` grammar already accepts `next=V1` (extended in I4, PR #18).

After V1: C1 (custom review roles) or I5 (validation and adjudication) per ROADMAP
order — C1's STATUS-id need is likewise already covered.

Dogfood runs from I3 onward: every increment PR (including V1's) is reviewed by this
tool via the dev-loop before merge. Never merge your own PR — the loop
(`node scripts/dev-loop.mjs --merge auto --dogfood on`, launched by the user from a
shell where `ZAI_API_KEY` is set) or the human owns merging.
