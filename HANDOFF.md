# HANDOFF.md — instructions for the next session

STATUS: next=V3

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

## Recorded state (2026-09-14, after V2)

- `main` = V2 complete (the ground-testing feedback round). Working tree clean. No open
  PRs should remain. **Version is 0.2.7**; tags `v0.2.0`–`v0.2.7` (each peels to its
  merge commit; ANNOTATED by explicit convention since I8 — see AGENTS.md). V2 landed
  via the supervised conventional path (user unavailable at session start — the FOURTH
  supervised landing after I7/M1/I8), so **the first loop-owned release milestone
  remains parked and belongs to the 1.0.0 era** (V3 or later).
- **V2 delivered (details in the ROADMAP row):** four real reviews of merged PRs
  (#43/#41/#37/#44) through the INSTALLED marketplace copy via a new driver
  `tests/groundtest-v2.mjs` (built on a `pluginDir: null` option in
  `tests/smoke-harness.mjs` — config discovery loads the marketplace artifact; never a
  second registration, so the uninstall dance is NOT needed for it — only for
  `--plugin-dir` smokes). Ground-test answers: **0/20 lane flakes** (incl. the
  file-backed 27-file/217 KB case — fail-closed partial semantics stay as designed, no
  retry/tolerance change warranted); **non-zero per-lane telemetry on every lane**
  (2.7–58 AIU; the I8 0-delta reading is the coarse-cadence exception); **review
  wall-clocks 9.4s–215.6s** (file-backed 3.6m ≪ the 20m dogfood cap — no budget tuning
  warranted). Three findings fixed (smoke double-failure disclosure; ownership-verified
  `releaseTagReservation` at both reservation-release sites — leased remote delete
  pinned to the tag OBJECT oid, verified-live git semantics; the `reviewDeadlineAt`
  review-level cap on `runLaneBatch` so file-backed transport-build time cannot restart
  the batch's total clock). Reviewing MERGED PRs yields findings against the then-tree
  (2 of 10 were already fixed on main by I8) — an expected property, not a defect.
- **The 1.0.0 decision is the user's, in V3 — never automatic.** The V2 data is the
  input: zero flakes, healthy telemetry, transport live and well inside budgets.
  Carried candidates for the user to disposition in V3 (ROADMAP V3 row): coverage
  successful-read correlation (verified FEASIBLE in V2 against the SDK's event types —
  `tool.execution_start.data.arguments` + `tool.execution_complete.data.success`,
  joined by `toolCallId`; strictly TIGHTENS the completeness gate, so it interacts
  with flake sensitivity), re-selection re-publication at an unchanged capture binding
  (post-v1 UX today — changing it reopens the settled I7 fold-3 marker design), and
  the parked first loop-owned release milestone (needs a healthy zcode-headless
  environment and the user's terminal launch).
- **Marketplace discipline (unchanged, gate-enforced):** entry bumped to 0.2.7/v0.2.7
  in-lockstep (xpepper/copilot-plugins e5807e5, rebased over the sibling's same-day
  d0a471e — if the push is rejected, pull --rebase and verify the gem-pr-review entry
  is untouched; never stomp). Uninstall the marketplace copy before any
  `--plugin-dir` session or manual smoke run from a normal shell (`copilot plugin
  uninstall z-pr-review`; verify with `copilot plugin list` — a first uninstall can
  leave a stale listing), and REINSTALL before handing back. Loop phases are exempt
  (isolated HOME). Full facts in AGENTS.md.
- **Publication is live (unchanged from I7):** `/z-pr-review N --comment` (or config
  `autoPostReviews`, unless `--no-comment`) publishes the retained settled selection
  as ONE gated COMMENT review; `select`/`inspect` do not publish. Batch
  `partial`/`failed` and `degraded` block the dogfood merge (fail-closed).
- **Attribution state:** I3–V2 are original code; `docs/ATTRIBUTION.md` lists no
  reused modules. The upstream LICENSE issue (10ego/pi-pr-review#150) stays open as a
  standing record.
- Tests: `node --test tests/*.test.mjs` (**483** on the V2 branch head, after dogfood
  fold 1 — the 1 P1 + 2 P2s the dogfood raised on the increment head were all
  validated real and fixed: capture-path cleanup trusted only from the code-rendered
  capture summary, never the model-influenced findings report, in BOTH the groundtest
  driver and smoke-i3's fallback; a failed ls-remote in the resolve-failure release
  fails the release instead of reading as an absent tag; the peel-match release
  additionally requires the remote object to exist in the local store — another
  actor's replacement tag is left alone). Smokes:
  `tests/smoke-i1.mjs` and `tests/smoke-i2.mjs` (SDK dispatch, no inference; i1 asserts
  the status `Version:` line against plugin.json, now 0.2.7), `tests/smoke-i3.mjs`
  (SDK dispatch; real inference inside lane children BY DESIGN; skips cleanly with no
  open PR; when the loop runs it, `SMOKE_INCREMENT` scopes it to the assessed PR —
  manual runs keep the generic default), `tests/smoke-m1.mjs` (marketplace consistency,
  no SDK, network: entry present, root path, version + ref tag == plugin.json),
  `tests/smoke-l1.mjs` (dev-loop `--dry-run` with `--merge auto --dogfood on`), and
  `tests/groundtest-v2.mjs` (NOT a gate — the V2 ground-test driver: one real review
  of a named PR, merged ones via `--include-closed --no-comment`, through the
  INSTALLED copy). All gates must pass before merge. Run smokes from a shell with the
  real `HOME` (or `COPILOT_SDK_PATH` set) — the harness resolves the bundled SDK from
  `~/.copilot/pkg`.
- zcode headless auth remains `ZAI_API_KEY` env (user's terminal only — the
  launchd-sourced value is stale) + keyless `~/.zcode/cli/config.json`; the
  `zcode-headless` preflight fails fast if that regresses. If the loop stays
  environment-blocked, the supervised conventional path is proven (I7, M1, I8, V2).

## Next increment: V3 — the 1.0.0 release decision round

The USER calls 1.0.0; the session lands their decision (ROADMAP V3 row):

- **Decision conversation first**, on the V2 data (0/20 flakes, non-zero telemetry,
  file-backed transport live at 3.6m ≪ 20m): satisfying → a small increment bumps
  0.2.7 → 1.0.0; not satisfying → V4+ and iterate. Never bump 1.0.0 without the
  user's explicit call.
- **Disposition the carried candidates** (user's call, do not land unilaterally):
  coverage successful-read correlation (feasible; tightens the completeness gate),
  re-selection re-publication UX (settled marker design), the parked first loop-owned
  release milestone.
- Dogfood from I3 onward stands: every increment PR (including V3's, if it lands code)
  is reviewed by this tool before merge.

Bump discipline: an increment that changes code bumps `plugin.json` (additive → patch
pre-1.0; 1.0.0 only by the user's explicit call) **together with the marketplace
entry** (one-line direct push to xpepper/copilot-plugins, disclosed in the increment
PR — pull --rebase on rejection, never stomp the sibling's entries) —
`tests/smoke-m1.mjs` fails the assessment otherwise. The release tag `vX.Y.Z` is
pushed at merge (ANNOTATED, `-a -m "z-pr-review release vX.Y.Z"`, peels to the merge
commit), never from a branch; fresh installs fail on the missing ref inside that
window (disclose it).

Dogfood runs from I3 onward: every increment PR (including V3's, if it lands code) is
reviewed by this tool via the dev-loop before merge. Never merge your own PR — the loop
(`node scripts/dev-loop.mjs --merge auto --dogfood on`, launched by the user from a
shell where `ZAI_API_KEY` is set) or the human owns merging; a supervised session
merges only on a P2-only-or-clean dogfood verdict, verified base and surgical diff
before merging (the #38/#39 standing policy).
