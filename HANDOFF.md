# HANDOFF.md — instructions for the next session

STATUS: next=I3

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

## Recorded state (2026-09-10, after L2)

- `main` = L2 complete (autopilot merge mode, PR #9), assuming that PR merges. Working
  tree clean. No open PRs should remain.
- L2 shipped (non-plugin): `--merge human|auto` on the dev-loop (default **human**,
  explicit value required, exit 2 otherwise). `auto` = the **loop** squash-merging
  under code-owned conditions: green gates + clean active reviews + **head pinned**
  (the assessment records the PR `headRefOid`; the loop re-fetches it immediately
  before `gh pr merge`; a moved head re-enters assessment once, a second move stops).
  Pre-I3 `auto` merges on the independent review alone. The assessment path also
  checkout+ff-only-syncs the PR branch to origin so gates/reviews test the exact head
  the pin records (as the extracted `gateBranchHead` gate: checkout → ff-only sync →
  rev-parse == headRefOid). Suite: 135 unit tests + smoke-i1/i2/l1 green.
- `--dogfood on` still refuses to run pre-I3, and **enforcing `--merge auto` ⇒
  `--dogfood on` is I3's obligation** (L2 deliberately did not build it).
- Workers/reviewer/fixer stay merge-denied (`--disallowed-tools "Bash(gh pr merge *)"`
  + prompts). Merging is loop-owned or human — never agent-discretion.
- Runtime fact that keeps recurring: the prior `copilot-pr-review` prototype can
  re-register itself any session (I1 hazard). The prototype-absent gate catches it;
  remedy remains `copilot plugin uninstall copilot-pr-review`.
- **First real loop run failed (2026-09-10) and was root-caused** — two causes,
  both now handled: (1) zcode 0.16.5 rejects `--max-turns` at parse time (its
  `--help` still lists it; `--settings` is dead the same way) → the loop no longer
  sends it, wall-clock timeouts bound phases; (2) standalone headless zcode needs
  its own model config + auth (the app's OAuth is ignored) — config shape and the
  key/login options are documented in AGENTS.md ("Environment facts — zcode CLI").
  **Before the next loop run the user must provide auth** (a `zai` API key via
  `~/.zcode/cli/config.json`/env, or one interactive `zcode login` — the keyless
  route is unverified). A new preflight gate (`zcode-headless`, one cheap probe
  turn) fails fast with the CLI's own error instead of burning a worker phase.
- Tests: `node --test tests/*.test.mjs` (135). Smokes: `tests/smoke-i1.mjs`,
  `tests/smoke-i2.mjs` (SDK dispatch, share `tests/smoke-harness.mjs`),
  `tests/smoke-l1.mjs` (script smoke: dev-loop `--dry-run`; transitively runs the
  full suite + both SDK smokes — allow a few minutes). All must pass before merge.

## Next increment: I3 — first minimal review (dogfood entry point)

One heavy lane over the captured diff via a **Copilot SDK child runtime** (owned
`CopilotClient`/`RuntimeConnection`, envelope-marker output contract — structured
output is broken on Copilot CLI 1.0.83), findings parsed and rendered in-chat.
`/pr-review N` becomes a real review command over I2's capture. No tiers (I4), no
validation/adjudication (I5), no publication (I7).

I3 additionally owes the dev-loop:

- Replace the `runDogfood: undefined` stub in `scripts/dev-loop.mjs` with the real
  SDK-dispatched review (`--no-comment`), map validated P0/P1 findings into the
  review-file contract, and make `--dogfood on` runnable.
- **Enforce `--merge auto` ⇒ `--dogfood on`** (refuse to run otherwise).
- Calibrate `PHASE_LIMITS` empirically in the supervised first run (spec open items
  1–3; also settle the zcode completion signal if still open).

Run I3 **through the dev-loop** (it is the first fully automated increment and the
first the plugin reviews itself). For I3's own supervised run, `--merge human` is
recommended — calibrate the loop with human eyes on the first real merge. From I4,
run unattended batches with:

    node scripts/dev-loop.mjs --merge auto --dogfood on [--max-iterations N]

The upstream LICENSE issue (see `docs/ATTRIBUTION.md`) must be filed before I4+
reuse — not needed for I3.

After I3: I4 — topologies and tiers (quick/balanced/full/deep lane sets, tiered
models + fallbacks, concurrent lanes, budgets with cancellation).
