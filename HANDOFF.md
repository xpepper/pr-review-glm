# HANDOFF.md — instructions for the next session

STATUS: next=M1

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
- **After I7:** M1 — generic Copilot plugin marketplace (next section), then I8 —
  hardening: large-diff file-backed transport (≥200 KB manifest + required read
  ranges), lane/credit telemetry from runtime events, dogfood-driven fixes; `1.0.0`
  when I8 completes.
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

## Next increment: M1 — generic Copilot plugin marketplace

Goal (user-commissioned 2026-09-13): one-command install of z-pr-review via a
GENERIC public marketplace repo the user owns — `xpepper/copilot-plugins`,
decided with the user (name + public visibility) — designed to host entries for
ALL the user's Copilot plugins, not just this one.

Verified mechanics (GitHub reference marketplace `github/copilot-plugins`,
local `copilot plugin --help` on 1.0.48; docs: the plugins-marketplace how-to):
- Manifest: `.github/plugin/marketplace.json` — the ONLY required component;
  `.claude-plugin/marketplace.json` accepted as an alternate location.
- Schema: top-level `name`, `metadata{description,version}`, `owner{name,email}`,
  `plugins[]`; entry fields: `name`, `description`, `version`, `author{name,url}`,
  `homepage`, `keywords[]`, `license`, `repository`, `source`.
- External-repo source (ours): `{"source":"github","repo":"xpepper/pr-review-glm","path":"."}`.
- Install UX: `copilot plugin marketplace add xpepper/copilot-plugins` →
  `copilot plugin install z-pr-review@copilot-plugins`.

Scope: (1) create `xpepper/copilot-plugins` public — conventional session work,
user-commissioned, NOT loop-gated; manifest + README, z-pr-review as the first
entry with entry version == `plugin.json`; (2) in THIS repo (the loop-gated
increment PR): README/AGENTS install-path docs, and a no-inference
marketplace-consistency smoke (entry exists, points at this repo, entry version
== `plugin.json` version) wired into the gate smokes — its failure message must
point at the marketplace repo. Release discipline, gate-enforced from now on:
every increment that bumps `plugin.json` also bumps the marketplace entry
(one-line direct push to the marketplace repo, disclosed in the increment PR) —
the consistency smoke fails the next assessment if skipped.

Verify live, document the answers: root `path: "."` acceptance (the reference
impl only shows subdirectory paths); whether marketplace-installed plugins
still need `--experimental` on 1.0.83; uninstall any locally installed copy
before `--plugin-dir` dev sessions (double registration = the I1
dispatch-ambiguity class).

Bump `plugin.json` 0.2.4 → 0.2.5 (additive), and land the matching marketplace
entry bump in the same increment. See the M1 ROADMAP row for the full brief.

After M1: I8 — hardening (large-diff file-backed transport, lane/credit
telemetry, dogfood-driven fixes; `1.0.0` when I8 completes).

Dogfood runs from I3 onward: every increment PR (including I8's) is reviewed by
this tool via the dev-loop before merge. Never merge your own PR — the loop
(`node scripts/dev-loop.mjs --merge auto --dogfood on`, launched by the user from a
shell where `ZAI_API_KEY` is set) or the human owns merging.
