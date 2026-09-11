# Roadmap — pr-review-glm

The full increment plan and where we are on the journey. Authoritative for status;
the [design spec](docs/superpowers/specs/2026-09-09-copilot-pr-review-port-design.md) is
authoritative for what each increment must deliver.

**Where we are:** V1 complete. **Next:** C1 — custom review roles.

Core principles (from the spec): small sequential increments, each landing as a PR;
dogfood from I3 onward — every increment PR is reviewed by this tool itself before merge.

## Increments

| ID | Status | Independently demonstrable outcome | Depends on |
|----|--------|------------------------------------|------------|
| I0 | ✅ Done (PR #2) | Project context persisted: README, AGENTS.md, HANDOFF.md, ROADMAP, ATTRIBUTION policy; repo public with `main` PR-protected. | — |
| I1 | ✅ Done (PR #3) | Installable plugin skeleton: `plugin.json` + extension registering `/pr-review` (status/help only) and `/pr-review-config show\|set\|unset`; schema-versioned config at `~/.copilot/pr-review-glm/config.json` (tiers, default mode, autoPostReviews, deadlines). No model calls; no-inference smoke script proves command registration + config round-trip. Evidence: 48 unit tests (`node --test tests/*.test.mjs`) + `node tests/smoke-i1.mjs` (SDK-dispatched commands, zero inference events, 0600 config round-trip). | I0 |
| I2 | ✅ Done (PR #6) | Read-only PR capture: `/pr-review N --capture-only [--include-drafts] [--include-closed]` fetches metadata/base/head/diff via `gh` into a 0600 temp file, freezes repo/PR binding, enforces draft/closed gates, refuses fail-closed on unauthenticated `gh`, gh errors/timeouts, inconsistent repo/head state (incl. a head-moved re-check after the diff fetch), or empty diff. Evidence: 81 unit tests (`node --test tests/*.test.mjs`, incl. fake-`gh` capture suite) + `node tests/smoke-i2.mjs` (SDK-dispatched capture of real PR #3 with closed-gate refusal, 0600 envelope, frozen binding, zero inference events; harness shared with smoke-i1 via `tests/smoke-harness.mjs`; also demonstrated against open PR #6 itself). | I1 |
| L1 | ✅ Done (PR #7) | **dev-loop** (non-plugin increment): `scripts/dev-loop.mjs` orchestrating fresh headless agent phases per increment (worker → gates → independent review → fixer → merge), `STATUS:` protocol in HANDOFF, prompt templates, `--dry-run`. Spec: `docs/superpowers/specs/2026-09-10-dev-loop-design.md`. Evidence: 39 new unit tests across `tests/dev-loop-{status,phases,gates,loop}.test.mjs` (120 total) + `node tests/smoke-l1.mjs` (no-agent dry-run green on the branch: status/prototype/tests/smokes gates PASS, context-dependent gates SKIPPED); the prototype-absent gate caught a live re-registration of the prior prototype mid-increment. Merging stayed human for L1 itself (`--dogfood on` refuses to run before then); `--merge auto` arrives with L2. | I2 |
| L2 | ✅ Done (PR #9) | **autopilot merge mode** (non-plugin increment): `--merge human\|auto` on the dev-loop — the loop itself squash-merges the increment PR when gates are green, all active reviews are clean, and the reviewed head is unchanged (headRefOid recorded at assessment, re-fetched and pinned immediately before `gh pr merge`; a moved head re-enters assessment once, a second move stops); merging stays loop-owned and code-governed, never agent-discretion. Default human, auto always an explicit flag; pre-I3 auto = explicit opt-in on the independent review alone; from I3, auto additionally requires the dogfood review (enforced by I3's wiring). The assessment path also ff-only-syncs the PR branch to origin so gates/reviews test the exact head the pin records. Evidence: 135 unit tests (`node --test tests/*.test.mjs`, incl. the merge-mode matrix: auto+dogfood-off merges with post-merge gates; human stops at awaiting-human-merge (default and with dogfood on); auto never merges on blocking findings, fatal review stops, exhausted fixer budget, unknown/unpinnable head, or a twice-moved head; plus `gateBranchHead` fake-run coverage of the checkout → ff-only-sync → rev-parse==headRefOid wiring) + `node tests/smoke-i1.mjs` + `node tests/smoke-i2.mjs` + `node tests/smoke-l1.mjs` (dry-run green with `--merge auto`, header surfaced). Fresh-eyes review (no prior context): approve-with-nits — its P1 (head-establishment wiring inline and untested in the CLI entry) fixed by extracting `gateBranchHead` into gates.mjs with tests; P2s taken: precise no-valid-headRefOid message, shared `isFullOid` validator on both ends of the pin, smoke-l1 exercising the positive `--merge auto` path; the disclosed scope-addition P2 was already flagged in the PR and endorsed as-is. Merging of L2's own PR stayed human (the flag didn't exist until it landed). | L1 |
| R1 | ✅ Done (PR #12) | **Plugin identity rename to z-pr-review** (mechanical, behavior-preserving; user decision 2026-09-10): plugin.json name; commands `/pr-review`→`/z-pr-review` and `/pr-review-config`→`/z-pr-review-config` (registration, parsing/usage/help/status text); extension dir `extensions/pr-review/`→`extensions/z-pr-review/`; config store `~/.copilot/pr-review-glm/`→`~/.copilot/z-pr-review/` (amends the settled config-path decision — user-local, schema-versioned, starts fresh, no migration); capture envelope kind + temp-dir prefix follow the plugin name. Motivation: sibling pi-pr-review ports on this machine register `/pr-review` names and command names are the dispatch collision surface (the I1 lesson); `z-` honors the zai GLM models. Repo name stays pr-review-glm; gate logic and the dev-loop untouched. Evidence: 138 unit tests + smoke-i1 + smoke-i2 + smoke-l1 green (commands registered under the new names, config round-trip at the new path, prototype-absent gate unchanged and passing). Spec amendment recorded in the port design spec's Amendments section. | L2 |
| I3 | ✅ Done (PR #15) | **First minimal review (dogfood entry point):** `/z-pr-review N [--no-comment]` captures the PR (I2 path) and runs one heavy lane over the diff in an owned Copilot SDK child runtime (`lane.mjs`: `view`/`grep`/`glob` confined by a realpath permission handler to the reviewed checkout, tier model/effort from config, attempt deadline with abort), envelope-marker output contract (`<<<REVIEW_BEGIN/END>>>` whole-line markers, one whole-response fence unwrapped), findings deterministically shaped (ladder severity + title; malformed candidates dropped and disclosed) and rendered in-chat with a machine-summary block. Dev-loop dogfood wiring landed with it: `runDogfood` dispatches the real `/z-pr-review <PR> --no-comment` via the shared smoke harness, asserts at dispatch that our command is registered with OUR description (the post-gate-removal protection), maps the machine summary into the review-file contract fail-closed (verdict is code-owned), `--merge auto ⇒ --dogfood on` enforced at both the CLI and `runLoop`, `PHASE_LIMITS.dogfood` 20m pending supervised-run calibration. Evidence: 163 unit tests (`node --test tests/*.test.mjs`, incl. envelope adversarial cases, confinement matrix, fake-runtime lane lifecycle, dogfood verdict mapping incl. injection/fail-closed cases, auto⇒dogfood refusals) + smoke-i1/i2 green under the new command description + `node tests/smoke-i3.mjs` — a real heavy-lane review of PR #15 itself (5 findings, all addressed or dispositioned), parent session inference-free (scenario skips cleanly on idle main) + smoke-l1 dry-run green with `--merge auto --dogfood on`; the independent review's approve-with-nits verdict had its three P2 hardening fixes folded in pre-merge (machine-summary field whitelist with sanitized `file`, lazy lane CLI resolution, hyphenated fence info strings). | I2, L1 |
| I4 | ✅ Done (PR #18) | **Topologies and tiers:** `--quick\|--balanced\|--full\|--deep` mode topologies as fixed, code-owned lane sets (upstream-documented ids/objectives — quick 3 heavy; balanced light overview + 4 heavy; full + medium conventions-maintainability; deep 1 integrated heavy — original code, no upstream source copied, so ATTRIBUTION keeps "none yet"); `runLane` generalizes the I3 heavy lane to any tier (model/effort from config, model override for fallback, AbortSignal cancellation); `runLaneBatch` runs lanes concurrently (concurrency = topology size) with per-lane progress, tier attempt caps clipped to batchMs/totalMs budgets, and one fallback attempt per lane on `tiers.<tier>.fallback` under fallbackMs; lifecycle classified complete/partial/failed with disclosure (complete only when every lane completed); multi-lane report + machine summary (mode, per-finding lane attribution, lanes array); default mode from config `defaultMode`. The dev-loop STATUS grammar now accepts V/C-series ids (the V1/C1 enabler, folded in with tests). Retryability is coarse by design (every failure retries once via fallback; fine-grained classification deferred to I8 telemetry) and per-mode findings policy is prompt-level only until I5 — both flagged in the PR. Evidence: 192 unit tests (`node --test tests/*.test.mjs`, incl. topology shape, batch concurrency/fallback/budget-clip/cancellation, batch report injection + partial coverage, V/C status ids) + smoke-i1/i2 green under the updated registration description + smoke-i3 green against PR #18 itself (real balanced batch: 5 lanes, real inference inside lane child runtimes, parent session inference-free) — live dogfood rounds on the increment's own PR drove real fixes in-PR: round 1 (4 P1 + 1 P3: child-startup failure escaping the batch, cancellation lost during runtime creation, unawaited child cleanup before the fallback attempt, misreported model label), round 2 (budget-unbounded runtime creation/cleanup, fallback over a possibly-live child, a HANDOFF typo), and round 3 (unbounded stop after cancelled creation, idle-before-send deadline bypass, incomplete-cleanup lanes reported complete, fallback over a still-spawning timed-out creation, bounded progress callbacks, fallback-attempt model labels, singular grammar, doc test counts), each with regression tests + smoke-l1 dry-run green. | I3 |
| V1 | ✅ Done | **Plugin release versioning (semantic):** `plugin.json` `version` follows semver so any user can tell which release they are running — bumped per merged release (pre-1.0: additive → patch, breaking → minor; `1.0.0` when I8 completes), the squash merge tagged `vX.Y.Z` on `main`, and `/z-pr-review status` reports the running version in-chat (read from `plugin.json` at status time, informational only, degrades to "(unknown)" — never a gate input). Design settled 2026-09-11 (journey entries): **every merged increment bumps**, enforced by a new dev-loop `version-bump` gate (`scripts/dev-loop/version.mjs`: fails an increment PR whose version is unchanged vs `origin/main`, fail-closed on git/parse errors, strict `X.Y.Z` shape on both sides); the **loop tags `vX.Y.Z`** in its merge path (`tagMergedRelease`: after squash-merge + checkout + ff-only pull, tag from `plugin.json` on main and push, fail-closed on read/parse/tag/push errors — a tag failure surfaces as a merge-path failure with a precise reason since the merge itself is already done). V1's own merge is tagged `v0.2.0` once by the supervisor as a bootstrap (the running loop predates the code); auto-tagging starts with the increment after V1. V1 itself lands as **0.2.0** — one minor leap acknowledging R1's breaking rename plus I2–I4 landing while the version sat stale at 0.1.0; additive increments after V1 → 0.2.1…. Protocol surfaces untouched (STATUS grammar, command descriptions, machine-summary shape all exactly as main). Evidence: 229 unit tests (`node --test tests/*.test.mjs`, incl. the new `tests/dev-loop-version.test.mjs` covering the bump-gate matrix and the tagging tail's fail-closed paths, plus a renderStatus version/unknown-degrade test) + smoke-i1/i2 (SDK dispatch; status now carries the version line) + smoke-l1 (dry-run) green. | — |
| C1 | ⬜ Pending | **Custom review roles:** user-defined reviewer lanes in config — each role is a prompt plus a tier (light/medium/heavy ⇒ budgets/fallback) with optional model and reasoning-effort overrides falling back to the tier's values; custom modes as ordered role lists, with the four standard modes as code-owned defaults that config may override. Custom-role findings must flow through the same deterministic validation/adjudication (I5) and publication gates (I7) as built-in lanes (prompts are model input, never authority). Amends the "fixed code-owned topologies" settled decision to "code-owned defaults + user-configurable composition" (record in the spec amendment when C1 is designed); config schemaVersion bump; roles edited directly in the config file for v1 (the key=value grammar doesn't fit multi-line prompts). Original extension — upstream has fixed topologies, nothing ported. Note: C1 introduces the first C-series id — the dev-loop's `STATUS:` grammar extension accepting V/C ids landed with I4 (PR #18). | I4 |
| I5 | ⬜ Pending | Validation and adjudication: deterministic candidate validation (severity ladder, anchors vs diff, evidence), isolated adjudicator call, dedup, per-mode findings policy, degraded assembly with coverage disclosure. | I4 |
| I6 | ⬜ Pending | Selection and retention: elicitation-based finding selection (`--all`, subset, none), retained settled result inspectable without inference. | I5 |
| I7 | ⬜ Pending | Gated COMMENT publication: single POST, ≤50 validated inline anchors, idempotency marker, stale/draft/self gates, uncertain-write reconciliation; `--comment` / `autoPostReviews`. | I6 |
| I8 | ⬜ Pending | Hardening: large-diff file-backed transport (≥200 KB manifest + required read ranges), lane/credit telemetry from runtime events, dogfood-driven fixes. | I7 |

Sizes are deliberately small (a focused session each). Later items may split further
without changing the spec; record splits here. Non-plugin increments (L-series) carry
the development workflow itself.

## Journey log

- **2026-09-11 (V1 landed)** — release versioning implemented as designed (no
  new decisions): `scripts/dev-loop/version.mjs` carries both code-owned pieces
  — `gateVersionBump` (wired into the worker gate batch after docs-updated;
  compares the PR branch's `plugin.json` against `git show origin/main:plugin.json`,
  requiring a strict `X.Y.Z` on both sides and a changed version, fail-closed on
  git/parse errors) and `tagMergedRelease` (the merge-path tagging tail:
  squash-merge → checkout main → ff-only pull → `git tag vX.Y.Z` →
  `git push origin vX.Y.Z`, all fail-closed; a tag failure returns a
  merge-phase failure with "release tag failed (merge itself completed)" so the
  stop reason is precise — the merge is not rolled back). The plugin reports
  its running version: `extension.mjs` reads `plugin.json` at status time
  (informational; an unreadable file degrades to "(unknown)", never errors —
  status text is not an authority path). `plugin.json` moved 0.1.0 → 0.2.0.
  Protocol surfaces untouched: command descriptions, machine-summary shape,
  and the STATUS grammar are exactly as main (`next=C1` needs no grammar
  change — V/C ids landed with I4). Bootstrap owed after merge: the supervisor
  pushes `v0.2.0` once (the running loop instance predates the tagging code);
  every increment after V1 auto-tags.

- **2026-09-11 (V1 design, approved in conversation)** — the three decisions the V1
  row deferred are settled. (1) **Bump gate:** every merged increment bumps
  `plugin.json` (pre-1.0: additive → patch, breaking → minor; `1.0.0` when I8
  completes), enforced by a new dev-loop gate that fails an increment PR whose
  version is unchanged vs `main`; supervisor fix/docs PRs never bump (they never
  pass through the loop). Mechanical and code-owned on purpose — classifying
  changes as behavior-affecting would put judgment in the authority path.
  (2) **Tagging:** the loop tags `vX.Y.Z` in its merge path — after squash-merge
  + checkout + ff-only pull, read `plugin.json`'s version on `main`, push the
  tag, fail closed on read/parse/push errors, unit-tested with the loop's suite.
  Bootstrap: the code lands inside V1's own PR, so the loop instance merging V1
  predates it — V1's initial `v0.2.0` is pushed once by the supervisor right
  after the merge; every later increment auto-tags. (3) **Starting number:**
  V1 lands as `0.2.0` — one minor leap acknowledging the breaking R1 rename
  (command/config names) plus I2–I4 landing while the version sat stale at
  0.1.0; `0.1.1` would understate a breaking change, and counting increments
  (0.5.0-style) is arbitrary since L-series and fix PRs don't map onto
  releases. Dev-loop spec amendment recorded with it.

- **2026-09-11 (I4 landed; post-I4 loop calibration + hardening):** I4 merged as
  8c1cdbb in the loop's first full `--merge auto` completion (adopt → gates →
  independent + dogfood reviews → merge of the pinned head b6955e8 → post-merge
  main-green), closing a five-run landing saga that taught the loop three
  lessons now landed (conventional fix PR, outside the loop): (1) per-phase
  duration capture — `phaseTimings` on every iteration in the report, the
  calibration data that was always missing; (2) a `mergeable` assessment gate —
  a CONFLICTING PR fails before reviews burn a cycle on it (the merge-time
  conflict cost one full run: gates + both reviews + a merge attempt);
  UNKNOWN passes and the pre-merge head pin stays the backstop; (3) MCP tool
  denial for loop phases — a reviewer agent's playwright tool call popped a
  visible automation Chrome mid-run (parent chain dev-loop → zcode-cli →
  playwright-mcp → Chrome), so `DENIED_TOOLS` now denies `mcp__*` and the known
  server names (parser acceptance verified on zcode 0.16.5; effect verified by
  Chrome-free runs). Calibration conclusions (spec open item 3): no
  PHASE_LIMITS change — observed worker 35–40m vs 90m, reviewer ≤~15m vs 20m
  (tightest margin), fixer 10–20m vs 45m, dogfood dispatch 1–3m vs 20m, heavy
  lane attempts ≤~2m vs 12m; timeouts protect, they don't bound throughput, and
  tuning now has data.

- **2026-09-11 (I4)** — topologies and tiers landed (PR #18): the I3 single
  heavy lane became a concurrent tiered batch. `topologies.mjs` records the
  four fixed mode lane sets with upstream-documented ids/objectives (verified
  against upstream's review prompt — original code, so ATTRIBUTION keeps its
  "none yet"; the filed LICENSE issue #150 remains a standing record rather
  than a reuse gate for this increment); `runLane` is tier-parametric with a
  model override for fallback attempts and AbortSignal cancellation;
  `runLaneBatch` runs the topology concurrently under the config budgets
  (tier attempt caps clipped to batchMs/totalMs, one fallback attempt per
  lane under fallbackMs, attempts disclosed per lane) and classifies the
  batch complete/partial/failed — complete only when every lane completed,
  so the dogfood verdict stays fail-closed (a partial batch blocks the
  merge). The mode flags went live with config `defaultMode` as default, the
  report gained per-lane lines with lane-attributed findings, and the
  dev-loop STATUS grammar now parses V/C-series ids (the ROADMAP-noted
  obligation for V1/C1, folded in here). Scope decisions flagged in the PR:
  retryability is coarse (every failure retries once via fallback; rich
  classification deferred to I8 telemetry) and per-mode findings policy is
  prompt-level only until I5 enforces it in code. Calibration still owed:
  the balanced batch (5 lanes) under the 12m batch cap versus
  `PHASE_LIMITS.dogfood` (20m) and the per-tier attempt defaults — adjust
  from observed loop timings.
  **Landing saga (same day):** landing took three resumed loop runs, two
  supervisor fix PRs for loop↔plugin protocol skew (below), and seven dogfood
  review rounds in total — rounds 5 (supervisor-folded) and 6–7 (loop fixer)
  hardened the lane lifecycle: null model-override semantics, synchronous
  stop-throw cleanup classification, cancellation awaiting the late child's
  bounded cleanup, abort-after-complete relabeling, parent cancellation
  propagation, a send-rejection relabel guard, and a final child-stop sweep
  clipped to the budgets. Final reviews: independent approve-with-nits (P2s
  only), dogfood approve-with-nits (3 P2s recorded: cancellation can leave a
  batch pending until the attempt deadline; hung child-stop promises retained
  for the extension lifetime; unconfirmed stops can accumulate live children
  across batches — hardening candidates for I5/I8).

- **2026-09-11 (I4 resumed run stopped on dogfood description skew — protocol
  rule):** run #2 (13 min) adopted PR #18 cleanly (the resume path from the
  previous fix worked: no worker re-dispatch, gates green, independent review
  ran) but stopped at the dogfood invocation: main's in-memory `dogfood.mjs`
  asserts the `/z-pr-review` registration description at dispatch, and the I4
  branch registers a new one ("concurrent tiered reviewer lanes") — the worker
  had updated the expected string only inside its own PR, invisible to the
  running loop. Same skew class as the STATUS grammar, now generalized into a
  rule: loop↔plugin protocol surfaces (STATUS grammar, command descriptions,
  machine-summary shape) change on `main` first, never inside the increment PR
  being validated — the worker prompt now says so. Fix (this PR): the branch's
  `dogfood.mjs` string/comment updates ported to main, and fatal
  review-invocation reasons carry the invocation's first error line (this
  failure surfaced as a bare `code=1`). Notable: the independent review
  completed — approve-with-nits with 1 P1 (a runtime-creation race loser never
  stops the late-resolving child) + 4 P2s — so the next resumed run should
  route into a fixer round on PR #18 before merge.

- **2026-09-11 (I4 first run stopped — loop resume + full-series STATUS ids):**
  the first I4 `--merge auto --dogfood on` run (46 min) stopped after its worker
  had completed and opened PR #18: the worker wrote `STATUS: next=V1` — the
  ROADMAP's post-I4 order is now V1, the first non-I/L id — and even folded the
  planned grammar extension into its own branch with tests, but the running loop
  validates docs against the grammar imported from `main` at launch, which still
  accepted only I/L ids → docs-updated gate failure → "blocking state with no
  known PR, not fixable" (the loop records the PR number only after the whole
  gate batch passes). Fix-forward on `main` (conventional PR, outside the loop):
  the STATUS grammar accepts `I/L/V/C` on `main` itself — the validating loop
  must know a grammar before any worker writes it (the extension the V1/C1 rows
  already required) — plus a resume path: startup recovers a checkout stranded
  on an increment branch to synced `main` (fail-closed on a dirty tree), and an
  unambiguous checkpoint (clean synced main, exactly one open PR, the
  increment's branch prefix) resumes at assessment, skipping only the worker
  re-dispatch — gates, both reviews, fixer, and head pinning all still judge the
  resumed PR. PR #18 itself stays untouched for the resumed run to assess.

- **2026-09-11 (V1 design, requested in conversation)** — new small increment
  **V1 — plugin release versioning** added to the plan (user request 2026-09-11,
  citing the superpowers plugin's versioned install as the example): the plugin
  follows semantic versioning so a user can tell which release they are running —
  `plugin.json` `version` bumped semantically per merged release (pre-1.0 `0.x.y`
  while increments land, `1.0.0` when the v1 scope completes), the squash merge tagged
  `vX.Y.Z` on `main`, and the running version surfaced in `/z-pr-review status` (the
  Copilot CLI already displays `plugin.json` versions — `copilot plugin list` — but
  ours has sat at a stale `0.1.0` since I1 and nothing tags or reports releases).
  Placed after I4 and before C1: I4 is already designed and targeted by HANDOFF, V1
  is small and independent so it slots in as a breather, and the `STATUS:` grammar
  extension it makes necessary (first V-series id) can cover the C-series in the same
  code PR. Exact bump gate and dev-loop enforcement are V1-design decisions.

- **2026-09-10 (I3)** — first real review landed: `lane.mjs` runs one heavy
  Copilot SDK child runtime over I2's captured diff (envelope-marker output
  contract — structured output stays broken on Copilot CLI 1.0.83; reads
  confined by a realpath permission handler, not by the prompt; attempt
  deadline aborts the child), `commands.mjs`/`extension.mjs` wire
  `/z-pr-review N [--no-comment]` end-to-end with findings rendered in-chat
  plus a machine-summary block for the loop. The dev-loop got its dogfood
  reviewer: dispatch-time registration assertion (name + OUR description,
  replacing the removed prototype-absent gate), fail-closed verdict mapping
  computed in loop code (never model text), and `--merge auto ⇒ --dogfood on`
  enforced both at the CLI (exit 2) and inside `runLoop` (stops before
  dispatching anything) — the L2 "auto additionally requires the dogfood
  review" amendment is now enforced, which deliberately changes the pre-I3
  auto-without-dogfood merge behavior (test updated, flagged in the PR).
  smoke-i3 is the first smoke that performs real inference, by design, inside
  the lane's child runtime; the parent session stream stays inference-free
  (harness assertion). PHASE_LIMITS.dogfood (20m) and the lane attempt
  deadline (config defaults) await supervised-run calibration.
  **First dogfood round (same day):** the plugin reviewed PR #15 itself
  (smoke-i3 against the open PR) and found 2 P1 + 3 P2, all legitimate —
  fixed: a dropped-everything summary can no longer read as a clean approve
  (`dogfoodVerdict` blocks when no usable findings survived), machine-summary
  parsing takes the LAST fenced block (a model title cannot smuggle a fake
  summary ahead of the code-generated one), `renderReview` flattens model text
  and neutralizes backticks inside the machine block, the dogfood timeout
  timer is cleared on completion, and smoke-i3's capture-cleanup ordering was
  corrected. One P2 taken as design-not-bug (documented in `lane.mjs`):
  prose before/after the envelope markers is tolerated — the spec's contract
  locates the payload via whole-line markers and one unwrapped fence rather
  than banning chatter; full findings validation is I5.

- **2026-09-10 (prototype-gate fix, after PR #13)** — the dev-loop's prototype-absent
  preflight gate was removed (user decision; conventional fix PR outside the loop).
  The gate predated the R1 rename and protected a real hazard then: the sibling
  `copilot-pr-review` prototype registers `/pr-review` names, ours used to too, and
  Copilot CLI dispatch is ambiguous on a shared command name (the I1 lesson). R1's
  rename to `/z-pr-review` names made that collision structurally impossible, while
  the prototype kept re-registering itself — the first real I3 loop run
  (`--merge human`) stopped at preflight on that benign condition. The gate was also a
  weak proxy regardless (registry state at preflight time, not dispatch time): the
  robust protection is asserting at dispatch that our commands are registered with our
  descriptions (the `waitForCommands` pattern in `tests/smoke-harness.mjs`), now owed
  by I3's dogfood wiring. Historical rows above keep the gate as written at the time.
  Evidence: 137 unit tests + smoke-i1/i2/l1 green with the sibling prototype still
  registered (deliberately left installed).

- **2026-09-10 (C1 design, approved in conversation)** — new post-I4 increment
  **C1 — custom review roles** added to the plan: the user wants pluggable extra
  reviewer roles defined by a prompt, a preferred model, and a preferred reasoning
  effort — alongside the standard specialists, or replacing them per mode. Shape
  agreed in conversation: a role = prompt + tier (the budget/fallback class) with
  optional model/effort overrides that fall back to the tier's values; modes become
  ordered role lists over code-owned standard defaults, overridable in config;
  custom-role findings flow through the same validation/adjudication/publication
  gates (prompts never gain authority — severity, anchors, blocking stay
  code-classified). Config schemaVersion bump; prompts edited directly in the JSON
  file for v1. Placed after I4 rather than inside it (lanes, concurrency, and
  budgets must exist first; I4 is already the largest increment). Amends the
  "fixed code-owned topologies" settled decision — to be recorded in the spec's
  Amendments section when C1 is designed. Upstream is fixed-topology: C1 is
  original work, not a port. Fresh-eyes review of the roadmap PR also caught that
  C1 is the first C-series id: the dev-loop's `STATUS:` grammar (`next=<id>`)
  only parses `I`/`L` ids today, so it needs a code change before C1 becomes the
  active increment.

- **2026-09-10 (R1)** — plugin identity renamed to **z-pr-review** (PR #12): sibling
  pr-review ports are developed in parallel on this machine (the prior
  copilot-pr-review prototype; an active gem-pr-review) and command NAMES are what
  collide — any family plugin registering `/pr-review` makes Copilot CLI dispatch
  ambiguous (the I1 lesson). Renamed plugin.json name, both commands
  (`/z-pr-review`, `/z-pr-review-config`), the extension directory
  (`extensions/z-pr-review/`), and — amending a settled decision — the config store to
  `~/.copilot/z-pr-review/` (user-local and schema-versioned: starts fresh, no
  migration); capture envelope kind and temp-dir prefix follow the plugin name.
  Mechanical and behavior-preserving: gate logic and the dev-loop untouched (the
  prototype-absent gate stays exactly as is; with unique command names the sibling
  coexistence question becomes live again only at I3's dogfood wiring — noted in
  HANDOFF). The repo name stays pr-review-glm (history, links); no repo/remote rename.
  Historical rows above keep the old names as written at the time; the spec records a
  short amendment rather than a rewrite. The prototype re-registered itself twice more
  during R1 verification (at state check and mid-smoke-rerun, both caught by the
  prototype-absent gate) — documented remedy applied each time. Evidence: 138 unit
  tests + all three smokes green under the new names.

- **2026-09-10 (loop first-run fix, after PR #9)** — the first real
  `node scripts/dev-loop.mjs --merge human` run failed in the worker phase: zcode
  0.16.5's parser rejects `--max-turns` (exit 1 + usage dump) though `--help`
  still lists it (`--settings` is dead the same way). Deeper: standalone headless
  zcode ignores the running app's OAuth and needs its own model config + auth —
  `~/.zcode/cli/config.json` is read with a strict schema (a violation unloads the
  whole file into a generic "Model config is missing"), custom providers require
  `kind` + `options.baseURL`, and an API key is mandatory until `zcode login` is
  proven otherwise (unverified — needs the user's browser). Fixes: the loop stops
  sending `--max-turns` (wall-clock timeouts are the bound; PHASE_LIMITS keeps
  maxTurns for I3 calibration), and a new preflight gate `zcode-headless` runs a
  one-turn probe with the exact worker arg set so flag drift or missing auth fails
  in seconds, before any phase is dispatched. Headless auth resolved the same day
  and verified end-to-end: the user's pre-existing `ZAI_API_KEY` env var plus a
  keyless config (recipe in AGENTS.md); the loop must run from a shell where the
  var is set.

- **2026-09-10 (L2)** — autopilot merge mode landed (PR #9): `--merge human|auto`
  (default human, explicit value required, exit 2 otherwise) decoupled merging from
  the dogfood flag — the loop now merges in `auto` mode on green gates + clean
  active reviews, with the merge decision code-owned in `runLoop` exactly like the
  gates. Head pinning per the amended spec: the assessment records the PR
  `headRefOid` (surfaced through the increment-pr gate/wiring), the loop re-fetches
  it immediately before `gh pr merge` (40-hex-validated, fail-closed on gh errors),
  a moved head re-enters assessment once and a second move stops rather than
  merging unreviewed commits. Implementation note: because the reviewer and gates
  run against the local checkout while the pin compares remote OIDs, the assessment
  path now checkout+ff-only-syncs the PR branch to origin — without that, a moved
  head would be tested and reviewed against a stale tree. Workers/reviewer/fixer
  remain merge-denied (`--disallowed-tools` + prompts); `--dogfood on` still refuses
  to run pre-I3; `auto⇒dogfood` enforcement is I3's obligation. Tests: merge-mode
  matrix in `tests/dev-loop-loop.test.mjs` + CLI exit-2 micro-tests in
  `tests/dev-loop-cli.test.mjs` + `gateBranchHead` fake-run tests (122 → 135). The
  fresh-eyes review round (approve-with-nits) drove the P1 fix: the head-establishment
  wiring left inline in the CLI entry was extracted into `gateBranchHead`
  (gates.mjs) and covered; P2s folded in (precise no-head message, shared `isFullOid`
  on both pin ends, smoke-l1 runs `--dry-run --merge auto`). No new runtime facts; no
  spec changes (implemented the already-amended design as-is).

- **2026-09-10 (autopilot merge design)** — Approved in conversation: **L2 (autopilot
  merge mode)** inserted between L1 and I3. `--merge human|auto`, default **human**
  and always an explicit flag (no silent default flips): `auto` is the *loop*
  merging under code-owned conditions (green gates + clean active reviews + resolved
  fixer), never an agent-discretion merge — same authority-path rule the plugin
  applies to publication. Pre-I3 `auto` opts into single-review merging (bounded:
  squash-revertible, post-merge main-green stops on red); post-I3 `auto` requires
  the dogfood review (I3 enforces). Spec amended (merge-policy row, architecture
  step 7, guardrails, CLI, sequencing + Amendments section); HANDOFF targets L2.

- **2026-09-10 (L1)** — dev-loop landed (PR #7): `STATUS:` parsing + ROADMAP eligibility,
  process runner with SIGTERM→SIGKILL timeouts and zcode arg builders (merge denied via
  `--disallowed-tools`), deterministic gates (repo-idle, prototype-absent, tests, smokes,
  increment-pr, docs-updated, main-green), the iteration state machine (dual review, ≤2
  shared fixer rounds, invocation failures fatal), the CLI entry with `--dry-run` +
  `.dev-loop/` reports (gitignored), and the three prompt templates; `STATUS:` protocol
  introduced in HANDOFF. Plan-vs-tree drift was reconciled and flagged in the PR (7
  plan-code/test corrections, incl. dry-run exit code, worked-increment capture for
  docs-updated, loop iteration accounting, machine-dependent CLI-resolution test, and the
  I2 shared smoke-harness being excluded from smoke enumeration). Runtime facts: the prior
  `copilot-pr-review` prototype re-registered itself mid-session (I1 hazard is real and
  recurring) — the prototype-absent gate caught it and the documented uninstall fixed it;
  `smoke-l1` is a script smoke with no Copilot SDK dispatch, so it does not use the SDK
  harness (AGENTS.md wording updated).

- **2026-09-10 (I2)** — Read-only PR capture landed: `capture.mjs` (gh auth pre-check,
  repo-binding freeze via `gh repo view`, `gh pr view --json` + `gh pr diff` with
  number-echo/SHA-shape/base≠head consistency checks, draft/closed skip gates, 0600
  temp-file envelope with the diff embedded), full review-flag grammar in
  `parseReviewArgs` (inert flags rejected with `--capture-only`), `renderStatus`/
  `renderHelp`/`renderCapture`, and the smoke harness extracted to
  `tests/smoke-harness.mjs` so smoke-i1 and the new smoke-i2 share one no-inference
  dispatch path. Runtime facts: none new — the I1 SDK dispatch pattern carried over
  unchanged; `gh` runs as a plain child process of the extension (invisible to the
  session event stream, which is what the zero-inference assertion checks).

- **2026-09-10 (dev-loop design)** — Approved in conversation: a script-orchestrated
  increment loop (`scripts/dev-loop.mjs`) with fresh headless agent phases, deterministic
  gates, dual review before auto-merge (independent reviewer always; the plugin's own
  dogfood review from I3; human merges until then), `STATUS:` protocol in HANDOFF.
  Spec in this PR; ROADMAP amended with L1 between I2 and I3.

- **2026-09-09** — Research (upstream pi-pr-review v1.18.1 architecture map, Copilot CLI
  extensibility, prior `copilot-pr-review` prototype facts), design approved through
  Q&A, spec written and merged (PR #1) with the two core principles. Repo pushed
  public; `main` protected (PRs required, admins bound, force pushes off). I0 merged (PR #2).
- **2026-09-09 (I1)** — Plugin skeleton + configuration landed: `plugin.json`, extension
  registering `/pr-review status|help` and `/pr-review-config show|set|unset`,
  schema-versioned 0600 config store with whole-object validation, 46 unit tests and an
  SDK-dispatched no-inference smoke script. Runtime facts learned en route: headless
  `copilot -p "/cmd"` starts an ambient model turn (direct dispatch must go through SDK
  `commands.execute`); two plugins registering the same command name dispatch
  ambiguously — the prior prototype was uninstalled (source checkout untouched).
  MIT LICENSE added.

## Backlog (post-v1, from the spec's out-of-scope list)

Incremental re-review (`--incremental` + prior-findings revalidation) · verification
profiles (tests against PR head in detached worktree) · self-review one-shot · APPROVE
publication with `approveMaxPriorityLevel` · project-trust config overrides ·
cross-session persistence of retained results · experimental finding extraction ·
live lane viewer UX · semantic benchmark suite · marketplace publishing · Agent Plugins
1.0 packaging (skills + MCP) for other agents.
