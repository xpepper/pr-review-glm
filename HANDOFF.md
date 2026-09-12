# HANDOFF.md — instructions for the next session

STATUS: next=I5

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

## Recorded state (2026-09-12, after C1)

- `main` = C1 complete (custom review roles), assuming the C1 PR merges. Working tree
  clean. No open PRs should remain.
- **Version is 0.2.1** (C1 was additive). Every merged increment bumps `plugin.json` —
  pre-1.0: additive → patch, breaking → minor — enforced by the dev-loop `version-bump`
  gate; the loop's merge path auto-tags `vX.Y.Z` (the supervisor bootstrapped `v0.2.0`
  after V1; auto-tagging covers everything after).
- **Custom roles are live:** config schemaVersion 2 adds `roles` (id → prompt + tier,
  optional model/effort overrides falling back to the tier's) and `modes` (name →
  ordered lane/role id lists; a standard mode name overrides its built-in topology);
  a custom mode is selected via `defaultMode`. Roles/modes are edited directly in the
  config file — `/z-pr-review-config show` renders them read-only. A v1 config file is
  rejected whole-object (defaults activate) — flagged in the C1 PR. Spec amendment
  recorded (topologies = code-owned defaults + user-configurable composition).
- **Reviews otherwise work as in I4:** `/z-pr-review N [--quick|--balanced|--full|--deep]
  [--no-comment]`; batch `partial`/`failed` blocks the dogfood merge (fail-closed).
  Custom-role lanes flow through the identical budgets/shaping — and, from I5, must
  flow through validation/adjudication exactly like built-in lanes.
- **I5 obligations to remember when designing it:** deterministic candidate validation
  (severity ladder, anchors vs diff, evidence quotes), one isolated adjudicator call
  (heavy tier, envelope contract, `deadlines.adjudicationMs` budget), dedup,
  per-mode findings policy (until now prompt-level only — I5 moves it into code),
  degraded assembly with coverage disclosure. `adjudicate.mjs` is the planned module
  (spec "Components"); porting candidates from upstream `lib/` would need
  `docs/ATTRIBUTION.md` entries.
- **Bump reminder for I5's worker:** additive → `0.2.2` (unless design makes something
  breaking, then `0.3.0`).
- **Attribution state:** I3–C1 are original code; `docs/ATTRIBUTION.md` lists no reused
  modules. The upstream LICENSE issue (10ego/pi-pr-review#150) stays open as a standing
  record.
- **Calibration owed:** the balanced batch (5 lanes, 12m batch cap) vs
  `PHASE_LIMITS.dogfood` (20m) and per-tier attempt defaults — adjust from observed
  loop timings (`.dev-loop` reports carry `phaseTimings`); also settle the zcode
  completion signal if still open (dev-loop spec open items 1–3).
- zcode headless auth remains `ZAI_API_KEY` env + keyless `~/.zcode/cli/config.json`;
  the `zcode-headless` preflight gate fails fast if that regresses. zcode 0.16.5
  still rejects `--max-turns`/`--settings` at parse time.
- Tests: `node --test tests/*.test.mjs` (310). Smokes: `tests/smoke-i1.mjs`,
  `tests/smoke-i2.mjs` (SDK dispatch, no inference), `tests/smoke-i3.mjs` (SDK
  dispatch; the lane children perform real inference BY DESIGN — parent session
  stays inference-free; scenario skips cleanly when no PR is open; full 5-lane
  balanced batch by default — budget ~12m), `tests/smoke-l1.mjs` (script smoke:
  dev-loop `--dry-run` with `--merge auto --dogfood on`; transitively runs
  everything — allow a few minutes). All must pass before merge. NOTE: run smokes
  from a shell with the real `HOME` (or `COPILOT_SDK_PATH` set) — the harness
  resolves the bundled SDK from `~/.copilot/pkg`.

## Next increment: I5 — validation and adjudication

Deterministic host-side candidate validation (severity ladder, anchors vs the captured
diff, evidence quotes), one isolated adjudicator model call merging/deduplicating/
classifying candidates, per-mode findings policy enforced in code (not prompt-level),
and degraded assembly with coverage disclosure when validation/adjudication is
malformed. Custom-role findings must pass the same gates as built-in lanes — prompts
never gain authority. See the I5 ROADMAP row and the spec's "Review pipeline" /
"Publication gates" sections. Bump `plugin.json` to `0.2.2` (additive, expected).

Dogfood runs from I3 onward: every increment PR (including I5's) is reviewed by this
tool via the dev-loop before merge. Never merge your own PR — the loop
(`node scripts/dev-loop.mjs --merge auto --dogfood on`, launched by the user from a
shell where `ZAI_API_KEY` is set) or the human owns merging.
