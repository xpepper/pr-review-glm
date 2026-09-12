# HANDOFF.md — instructions for the next session

STATUS: next=C1

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

## Recorded state (2026-09-11, after V1)

- `main` = V1 complete (release versioning), assuming the V1 PR merges. Working tree
  clean. No open PRs should remain.
- **The plugin is versioned now (V1):** `plugin.json` sits at `0.2.0` and
  `/z-pr-review status` reports the running version in-chat (informational only).
  Every merged increment from here on must bump `plugin.json` — pre-1.0: additive →
  patch, breaking → minor — enforced by the dev-loop `version-bump` gate
  (`scripts/dev-loop/version.mjs`, `gateVersionBump`: branch vs `origin/main`,
  strict `X.Y.Z`, fail-closed). The loop's merge path auto-tags the merged main
  `vX.Y.Z` (`tagMergedRelease`, fail-closed) — **starting with the increment AFTER
  V1**, because the loop instance that merges V1 predates the tagging code; the
  supervisor pushes the bootstrap `v0.2.0` tag once, right after V1 merges.
- **Reviews still work as in I4:** `/z-pr-review N [--quick|--balanced|--full|--deep]
  [--no-comment]` captures and runs the mode's concurrent tiered lane batch; batch
  `partial`/`failed` blocks the dogfood merge (fail-closed). No validation/adjudication
  (I5), selection (I6), or publication (I7) yet.
- **C1 obligations to remember when designing it:** config schemaVersion bump; custom
  roles = prompt + tier with optional model/effort overrides; modes as ordered role
  lists over code-owned defaults (amends the "fixed code-owned topologies" settled
  decision — record it in the port design spec's Amendments when C1 is designed);
  roles edited directly in the config file (the key=value grammar doesn't fit
  multi-line prompts); custom-role findings flow through the same future I5/I7 gates.
- **Bump reminder for C1's worker:** C1 is additive → `0.2.1` (unless design makes
  something breaking, then `0.3.0`).
- **Attribution state:** I4/V1 are original code; `docs/ATTRIBUTION.md` still lists no
  reused modules. The upstream LICENSE issue (10ego/pi-pr-review#150) stays open as a
  standing record.
- **Calibration owed:** the balanced batch (5 lanes, 12m batch cap) vs
  `PHASE_LIMITS.dogfood` (20m) and per-tier attempt defaults — adjust from observed
  loop timings (`.dev-loop` reports now carry `phaseTimings`); also settle the zcode
  completion signal if still open (dev-loop spec open items 1–3).
- zcode headless auth remains `ZAI_API_KEY` env + keyless `~/.zcode/cli/config.json`;
  the `zcode-headless` preflight gate fails fast if that regresses. zcode 0.16.5
  still rejects `--max-turns`/`--settings` at parse time.
- Tests: `node --test tests/*.test.mjs` (272). Smokes: `tests/smoke-i1.mjs`,
  `tests/smoke-i2.mjs` (SDK dispatch, no inference), `tests/smoke-i3.mjs` (SDK
  dispatch; the lane children perform real inference BY DESIGN — parent session
  stays inference-free; scenario skips cleanly when no PR is open; full 5-lane
  balanced batch by default — budget ~12m), `tests/smoke-l1.mjs` (script smoke:
  dev-loop `--dry-run` with `--merge auto --dogfood on`; transitively runs
  everything — allow a few minutes). All must pass before merge.

## Next increment: C1 — custom review roles

User-defined reviewer lanes in config: each role is a prompt plus a tier
(light/medium/heavy ⇒ budgets/fallback) with optional model and reasoning-effort
overrides falling back to the tier's values; custom modes as ordered role lists, with
the four standard modes as code-owned defaults that config may override. Custom-role
findings must flow through the same deterministic validation/adjudication (I5) and
publication gates (I7) as built-in lanes — prompts are model input, never authority.
Design C1 in-conversation first (it amends a settled decision; record the spec
amendment in the PR), then implement small. See the C1 ROADMAP row and its journey
entries for the agreed shape. Bump `plugin.json` to `0.2.1` (additive).

Dogfood runs from I3 onward: every increment PR (including C1's) is reviewed by this
tool via the dev-loop before merge. Never merge your own PR — the loop
(`node scripts/dev-loop.mjs --merge auto --dogfood on`, launched by the user from a
shell where `ZAI_API_KEY` is set) or the human owns merging.
