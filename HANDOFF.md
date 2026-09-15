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

## Recorded state (2026-09-15, after R45 + S46)

- `main` = R45 + S46 complete (both from GitHub issues #45/#46, not ROADMAP-planned
  increments). Working tree clean. No open PRs should remain once the docs catch-up
  lands. **Version is 0.2.8**; tags `v0.2.0`–`v0.2.8` (each peels to its merge
  commit; ANNOTATED by explicit convention since I8 — see AGENTS.md). Tests:
  **528/528** on main (`node --test tests/*.test.mjs`, recounted 2026-09-15).
- **How R45/S46 landed — a new supervised pattern worth reusing:** one supervisor
  session, two implementer subagents in parallel git worktrees (disjoint file
  ownership), a fresh task-reviewer subagent per branch (spec + quality verdicts),
  fix rounds from review + dogfood folds, then the user merged both PRs (#49 first,
  #48 rebased onto it). Dogfood reviews ran through the INSTALLED copy
  (`tests/groundtest-v2.mjs` — works on open PRs too, `--no-comment`); SDK smokes
  ran serialized after the uninstall dance (see AGENTS.md).
- **R45 (PR #49) changed the release flow — read this before any release work:** the
  marketplace entry bump is now POST-MERGE. Pre-merge, `tests/smoke-m1.mjs` accepts
  the live entry at EITHER `plugin.json`'s version OR the last released tag (a
  new version in flight leaves the entry alone — no more missing-ref window). At
  merge: annotated tag first, then the entry bump (`bumpMarketplaceEntry` /
  `publishTaggedVersion` in `scripts/dev-loop/marketplace.mjs`; loop-wired in the
  merge tail; a supervised/manual landing runs its steps directly — first LIVE
  execution 2026-09-15 for 0.2.8, clean, verified by re-read). AGENTS.md's
  release-discipline passage describes the new flow.
- **S46 (PR #48): self-review publication is now possible** — `--comment
  --self-review` (accepted by the parser ONLY as that pairing) lets the PR's author
  publish the gated COMMENT review to their own PR, with a static code-owned
  disclosure in the posted body. Default self-author refusal stays fail-closed;
  config `autoPostReviews` can never imply the authorization. A solo-maintainer
  dogfood (`--comment --self-review` on the session's own PR) is now available if
  the user opts in.
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
- **Marketplace discipline (NEW FLOW since R45, gate-enforced):** entry at
  0.2.8/v0.2.8 as of 2026-09-15. The entry moves POST-merge only (tag first, then
  the surgical contents-API bump — never a pre-merge marketplace write for the
  in-flight version; pull --rebase semantics on rejection; never stomp the sibling
  gem-pr-review entry). Uninstall the marketplace copy before any `--plugin-dir`
  session or manual smoke run from a normal shell (`copilot plugin uninstall
  z-pr-review`; verify with `copilot plugin list` — a first uninstall can leave a
  stale listing), and REINSTALL/update before handing back. Loop phases are exempt
  (isolated HOME). Full facts in AGENTS.md.
- **Publication is live (S46 update):** `/z-pr-review N --comment` (or config
  `autoPostReviews`, unless `--no-comment`) publishes the retained settled selection
  as ONE gated COMMENT review; the PR's own author publishes only with the explicit
  `--comment --self-review` pairing (disclosed in the posted body);
  `select`/`inspect` do not publish. Batch `partial`/`failed` and `degraded` block
  the dogfood merge (fail-closed).
- **Riding minors (non-blocking, fold opportunistically — do not reopen settled
  decisions for them):** S46 — commands.mjs inert-flag chain one nesting level
  deeper (flatten on the next flag); a help-text OR-assertion;
  `buildPublication` at 9 destructured params. R45 — the merge-tail comment's
  arm-2 rationale overstates when the tag exists; smoke-m1's PASS line names the
  arm by input side, not by which arm the entry matched; tags-pagination residual
  (first page only, 8/100 today — revisit near the cap). The loop-driven
  post-merge bump's first LOOP-WIRED run (vs. the supervised module invocation
  already executed live) is still to be observed at the first loop-owned release.
- **Attribution state:** I3–V2 are original code; `docs/ATTRIBUTION.md` lists no
  reused modules. The upstream LICENSE issue (10ego/pi-pr-review#150) stays open as a
  standing record.
- Tests: `node --test tests/*.test.mjs` (**528** on main, recounted 2026-09-15 after
  R45 + S46; recount whenever a doc claims a count — they drift). Historical V2 fold
  detail: dogfood folds 1–3 (fold 3 dispositioned the local-tag TOCTOU family as a DOCUMENTED DESIGN
  RESIDUAL after three repeating rounds — see releaseTagReservation's doc comment;
  fold 2: the resolve-failure path's unconditional local `git tag -d` now
  deletes only a resolvable tag matching the peel-verified object — the local twin of
  fold 1's remote ownership fix; fold 1 — the 1 P1 + 2 P2s the dogfood raised on the increment head were all
  validated real and fixed: capture-path cleanup trusted only from the code-rendered
  capture summary, never the model-influenced findings report, in BOTH the groundtest
  driver and smoke-i3's fallback; a failed ls-remote in the resolve-failure release
  fails the release instead of reading as an absent tag; the peel-match release
  additionally requires the remote object to exist in the local store — another
  actor's replacement tag is left alone). Smokes:
  `tests/smoke-i1.mjs` and `tests/smoke-i2.mjs` (SDK dispatch, no inference; i1 asserts
  the status `Version:` line against plugin.json, now 0.2.8), `tests/smoke-i3.mjs`
  (SDK dispatch; real inference inside lane children BY DESIGN; skips cleanly with no
  open PR; when the loop runs it, `SMOKE_INCREMENT` scopes it to the assessed PR —
  manual runs keep the generic default; `SMOKE_PR_NUMBER` forces a target), 
  `tests/smoke-m1.mjs` (marketplace consistency, no SDK, network: entry present,
  root path, version + ref agree internally and match EITHER plugin.json OR the
  last released tag — the R45 either-or gate),
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

Bump discipline (R45 flow, replaces the M1 same-increment rule): an increment that
changes plugin behavior bumps `plugin.json` (additive → patch pre-1.0; 1.0.0 only by
the user's explicit call) — and NOTHING else moves pre-merge: `tests/smoke-m1.mjs`
accepts the live entry at either `plugin.json` OR the last released tag. The release
happens at merge, in order: annotated tag `vX.Y.Z` at the merge commit
(`-a -m "z-pr-review release vX.Y.Z"` under `-c tag.gpgsign=false`, peels to the
merge commit, never from a branch), THEN the marketplace entry bump to `X.Y.Z`/
`vX.Y.Z` — the loop's merge tail does both automatically; a supervised/manual
landing runs `publishTaggedVersion` (or its steps) from `scripts/dev-loop/
marketplace.mjs` and discloses the marketplace commit in the increment PR. There is
no missing-ref window anymore; a skipped post-merge bump fails loudly rather than
stranding the release.

Dogfood runs from I3 onward: every increment PR (including V3's, if it lands code) is
reviewed by this tool via the dev-loop before merge. Never merge your own PR — the loop
(`node scripts/dev-loop.mjs --merge auto --dogfood on`, launched by the user from a
shell where `ZAI_API_KEY` is set) or the human owns merging; a supervised session
merges only on a P2-only-or-clean dogfood verdict, verified base and surgical diff
before merging (the #38/#39 standing policy).
