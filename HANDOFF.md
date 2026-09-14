# HANDOFF.md — instructions for the next session

STATUS: next=V2

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

## Recorded state (2026-09-14, after I8)

- `main` = I8 complete (hardening; the pre-1.0 closer). Working tree clean. No open PRs
  should remain. **Version is 0.2.6**; tags `v0.2.0`–`v0.2.6` (each peels to its merge
  commit; ANNOTATED by explicit convention since I8 — see AGENTS.md). I8 landed via the
  supervised conventional path (the user's explicit choice at session start — the third
  supervised landing after I7/M1), so **the first loop-owned release milestone now
  belongs to the 1.0.0 era** (V2 or later).
- **Version decision (user, 2026-09-14): 1.0.0 is DEFERRED.** I8 landed as the additive
  0.2.6; the user wants to ground-test 0.2.6 (real reviews, feedback, fixes) before
  calling the tool 1.0.0. V2 is that round; the 1.0.0 bump is the USER's call at its
  end, not automatic.
- **I8 delivered (details in the ROADMAP row):** large-diff file-backed transport
  (`extensions/z-pr-review/transport.mjs`: ≥200 KB diffs become per-file sections on
  disk + manifest prompts + required-read completeness enforced from permission
  events, file-granular by necessity — read requests carry paths, not ranges); lane/
  credit telemetry from `model.call_finished` + `session.usage_checkpoint` (per-lane,
  informational only, additive machine-block keys `transport` + `lanes[].telemetry`);
  the three riding I7 P2s fixed (bounded uncertain-write rescan, AbortSignal through
  paginated gh, smoke-i3 target alignment via `SMOKE_INCREMENT` + `selectIncrementPr`);
  the loop flags dispositioned (probe-transcript fake-stomp fixed by threading
  `artDir`/`persist` through `runPreflightGates`; fixer budget 4 + severity ladder;
  annotated release tags end-to-end; dogfood timeout kept at 20m with the arithmetic
  documented — NO observed data existed, so the first loop-owned run's
  `phaseTimings.dogfood` confirms or tunes it).
- **Known observation (manual verification, disclosed in the I8 PR):** a real lane's
  two `session.usage_checkpoint` events can carry an IDENTICAL `totalNanoAiu` (the
  debit cadence is coarser than per-call), so the derived per-lane spend reads 0 —
  telemetry never invents a delta. Watch whether real reviews show non-zero deltas
  during V2 ground testing.
- **Marketplace discipline (unchanged, gate-enforced):** entry bumped to 0.2.6/v0.2.6
  in-lockstep (xpepper/copilot-plugins, one-line direct push, disclosed in the PR).
  Uninstall the marketplace copy before any `--plugin-dir` session or manual smoke run
  from a normal shell (`copilot plugin uninstall z-pr-review`; verify with
  `copilot plugin list` — a first uninstall can leave a stale listing), and REINSTALL
  before handing back. Loop phases are exempt (isolated HOME). Full facts in AGENTS.md.
- **Publication is live (unchanged from I7):** `/z-pr-review N --comment` (or config
  `autoPostReviews`, unless `--no-comment`) publishes the retained settled selection
  as ONE gated COMMENT review; `select`/`inspect` do not publish. Batch
  `partial`/`failed` and `degraded` block the dogfood merge (fail-closed).
- **Attribution state:** I3–I8 are original code; `docs/ATTRIBUTION.md` lists no
  reused modules (I8's transport follows OUR spec's design; upstream is described in
  the research notes only). The upstream LICENSE issue (10ego/pi-pr-review#150) stays
  open as a standing record.
- Tests: `node --test tests/*.test.mjs` (**452** on the I8 branch head). Smokes:
  `tests/smoke-i1.mjs` and `tests/smoke-i2.mjs` (SDK dispatch, no inference; i1 asserts
  the status `Version:` line against plugin.json, now 0.2.6), `tests/smoke-i3.mjs`
  (SDK dispatch; real inference inside lane children BY DESIGN; skips cleanly with no
  open PR; when the loop runs it, `SMOKE_INCREMENT` scopes it to the assessed PR —
  manual runs keep the generic default), `tests/smoke-m1.mjs` (marketplace consistency,
  no SDK, network: entry present, root path, version + ref tag == plugin.json),
  `tests/smoke-l1.mjs` (dev-loop `--dry-run` with `--merge auto --dogfood on`). All
  must pass before merge. Run smokes from a shell with the real `HOME` (or
  `COPILOT_SDK_PATH` set) — the harness resolves the bundled SDK from `~/.copilot/pkg`.
- zcode headless auth remains `ZAI_API_KEY` env (user's terminal only — the
  launchd-sourced value is stale) + keyless `~/.zcode/cli/config.json`; the
  `zcode-headless` preflight fails fast if that regresses. The 2026-09-13 degradation
  (sessions AND subagents shell-less) may or may not persist — if it does, the
  supervised conventional path is proven (I7, M1, I8).

## Next increment: V2 — ground-testing feedback round (pre-1.0.0)

Scope (ROADMAP row, intentionally fluid — keep it small):

- **Ground-test 0.2.6**: run real reviews on real PRs (this repo's increments first;
  the user may point it at other repos). Collect what breaks, what telemetry shows,
  and whether file-backed transport ever triggers on real diffs (≥200 KB is rare —
  if it never fires, that is itself a finding about the threshold).
- **Dogfood-driven fixes**: fix what ground testing surfaces; riding P2s as they
  appear. Watch the telemetry deltas (the known 0-delta observation above) and the
  first loop-owned run's `phaseTimings.dogfood` (confirm or tune the 20m cap — the
  I8-documented arithmetic says ≈13.5m worst case).
- **The 1.0.0 decision is the user's**, at the end of V2: if ground testing is
  satisfying, a small increment bumps 0.2.6 → 1.0.0 (marketplace entry in-lockstep,
  per the M1 discipline); if not, V3 and iterate. Do not bump 1.0.0 without the
  user's explicit call.

Bump discipline: a V2 that changes code bumps `plugin.json` 0.2.6 → 0.2.7 (additive)
**together with the marketplace entry** (one-line direct push to
xpepper/copilot-plugins, disclosed in the increment PR) — `tests/smoke-m1.mjs` fails
the assessment otherwise. The release tag `vX.Y.Z` is pushed at merge, never from a
branch; fresh installs fail on the missing ref inside that window (disclose it).

Dogfood runs from I3 onward: every increment PR (including V2's, if it lands code) is
reviewed by this tool via the dev-loop before merge. Never merge your own PR — the loop
(`node scripts/dev-loop.mjs --merge auto --dogfood on`, launched by the user from a
shell where `ZAI_API_KEY` is set) or the human owns merging.
