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
`I`/`L`/`V`/`C` ids since I4 (PR #18) and `M` (marketplace infra) since M1 prep.

## Recorded state (2026-09-13, after M1)

- `main` = M1 complete (public marketplace). Working tree clean. No open PRs should
  remain. **Version is 0.2.5**; tags `v0.2.0`–`v0.2.5` (each peels to its merge
  commit). M1 landed via the supervised conventional path (the loop's 22:49 launch
  stopped environmental at the `zcode-headless` preflight: 3/3 shell-less probes);
  the loop-owned release milestone therefore still awaits its first landing —
  **I8 is the candidate**.
- **Marketplace (new, gate-enforced discipline):** install is
  `copilot plugin marketplace add xpepper/copilot-plugins` +
  `copilot plugin install z-pr-review@xpepper-copilot-plugins`. Marketplace NAME is
  `xpepper-copilot-plugins` (the CLI rejects `copilot-plugins` — built-in collision).
  Entry: external source, root `path: "."`, `ref` pinned to the release tag.
  Every `plugin.json` bump MUST also bump the marketplace entry version + ref tag in
  the same increment (one-line direct push to the no-gates marketplace repo,
  disclosed in the increment PR) — `tests/smoke-m1.mjs` fails the assessment
  otherwise (it reads the manifest via the fresh contents API, not the ~5-min-laggy
  raw CDN). Uninstall the marketplace copy before any `--plugin-dir` session AND
  before manual smoke runs from a normal shell
  (`copilot plugin uninstall z-pr-review`; verify with `copilot plugin list` — a
  first uninstall can leave a stale listing; loop phases are exempt: isolated
  HOME). Full facts in AGENTS.md ("Environment facts — plugin marketplace").
- **Publication is live (unchanged from I7):** `/z-pr-review N --comment` (or config
  `autoPostReviews`, unless `--no-comment`) publishes the retained settled selection
  as ONE gated COMMENT review; `select`/`inspect` do not publish. Batch
  `partial`/`failed` and `degraded` block the dogfood merge (fail-closed).
- **Attribution state:** I3–M1 are original code; `docs/ATTRIBUTION.md` lists no
  reused modules. The upstream LICENSE issue (10ego/pi-pr-review#150) stays open as a
  standing record.
- Tests: `node --test tests/*.test.mjs` (**419**). Smokes: `tests/smoke-i1.mjs` and
  `tests/smoke-i2.mjs` (SDK dispatch, no inference; i1 asserts the status `Version:`
  line against plugin.json), `tests/smoke-i3.mjs` (SDK dispatch; lane children and
  adjudicator perform real inference BY DESIGN — parent session stays inference-free;
  skips cleanly when no PR is open; full 5-lane balanced batch, budget ~13m),
  `tests/smoke-m1.mjs` (marketplace consistency, no SDK, network: entry present,
  points at this repo at root, version + ref tag == plugin.json), `tests/smoke-l1.mjs`
  (script smoke: dev-loop `--dry-run` with `--merge auto --dogfood on`). All must pass
  before merge. Run smokes from a shell with the real `HOME` (or `COPILOT_SDK_PATH`
  set) — the harness resolves the bundled SDK from `~/.copilot/pkg`.
- zcode headless auth remains `ZAI_API_KEY` env (user's terminal only — the
  launchd-sourced value is stale) + keyless `~/.zcode/cli/config.json`; the
  `zcode-headless` preflight fails fast if that regresses. As of 2026-09-13 ~22:50
  the environment was DEGRADED (sessions AND subagents shell-less, 3/3 probes) — if
  it persists, the supervised conventional path is proven (I7, M1).

## Next increment: I8 — hardening (then 1.0.0)

Scope (ROADMAP row): large-diff file-backed transport (≥200 KB manifest + required
read ranges), lane/credit telemetry from runtime events, dogfood-driven fixes.

Riding work flagged for I8 (from I7/M1 folds and reviews — validate against code
before fixing, disposition honestly):

- Review P2s: single-scan uncertain-write reconciliation; smoke-i3 vs gates target
  skew (i3 reviews whatever PR is open while gates assess the increment branch);
  AbortSignal not threaded through paginated `gh` calls.
- Loop flags: probe-transcript fake-stomp (persist-injection fix owed — unit-test
  fakes overwrite real probe transcripts under `.dev-loop/`); fixer-budget 2→4
  policy + severity ladder; lightweight-vs-annotated release tags (decide and
  document; today they are lightweight, peeling to merge commits).
- Deferred docs: ROADMAP journey notes for the I7 fixer commits, #38/#39, and M1 are
  partially covered by the M1 journey entry; fold the remainder into I8's docs pass.
- Dogfood calibration owed: balanced batch (5 lanes, 12m batch cap) + adjudicator
  (60s) vs `PHASE_LIMITS.dogfood` (20m) — adjust from observed `.dev-loop` timings.

Bump `plugin.json` 0.2.5 → 0.2.6 (additive) **together with the marketplace entry**
(the M1 discipline, smoke-enforced). `1.0.0` when I8 completes.

Dogfood runs from I3 onward: every increment PR (including I8's) is reviewed by
this tool via the dev-loop before merge. Never merge your own PR — the loop
(`node scripts/dev-loop.mjs --merge auto --dogfood on`, launched by the user from a
shell where `ZAI_API_KEY` is set) or the human owns merging.
