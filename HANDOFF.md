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

## Recorded state (2026-09-10, after the prototype-gate fix)

- `main` = prototype-absent-gate fix complete (conventional fix PR after #13), assuming
  that PR merges. Working tree clean. No open PRs should remain.
- **The dev-loop's prototype-absent preflight gate is gone** (user decision 2026-09-10,
  fix PR): it predated the R1 rename and hard-failed every loop run on the benign
  condition of the sibling `copilot-pr-review` prototype being registered (it keeps
  re-registering). With R1's `/z-pr-review` command names, that registration cannot
  collide with this plugin's dispatch — the prototype may stay installed; it is NOT a
  loop remedy to uninstall it. The robust protection is a dispatch-time assertion (see
  I3's obligations below). R1's note "at I3 decide whether the gate stays required" is
  resolved: removed.
- **The plugin's identity is z-pr-review** (R1, mechanical rename): commands
  `/z-pr-review` and `/z-pr-review-config`, extension dir `extensions/z-pr-review/`,
  config store `~/.copilot/z-pr-review/config.json` (user-local + schema-versioned,
  starts fresh — the old `~/.copilot/pr-review-glm/` directory is simply ignored, no
  migration). Capture envelope kind is `z-pr-review-capture`; capture temp dirs are
  prefixed `z-pr-review-`. The **GitHub repo name stays `pr-review-glm`** (history,
  links).
- L1/L2 loop facts unchanged and current: `--merge human|auto` (default human; auto =
  loop-owned squash merge on green gates + clean active reviews + pinned headRefOid,
  re-checked immediately before `gh pr merge`); workers/reviewer/fixer stay merge-denied;
  `--dogfood on` still refuses to run pre-I3. Suite: 137 unit tests + smoke-i1/i2/l1
  green (verified with the sibling prototype registered — the dry-run no longer cares).
- zcode headless auth remains resolved via `ZAI_API_KEY` (env) + keyless
  `~/.zcode/cli/config.json`; launch the loop from a shell where the var is set
  (`echo ${ZAI_API_KEY:+set}`). The `zcode-headless` preflight gate fails fast if that
  regresses. zcode 0.16.5 still rejects `--max-turns`/`--settings` at parse time.
- Tests: `node --test tests/*.test.mjs` (137). Smokes: `tests/smoke-i1.mjs`,
  `tests/smoke-i2.mjs` (SDK dispatch, share `tests/smoke-harness.mjs`),
  `tests/smoke-l1.mjs` (script smoke: dev-loop `--dry-run`; transitively runs the
  full suite + both SDK smokes — allow a few minutes). All must pass before merge.

## Next increment: I3 — first minimal review (dogfood entry point)

One heavy lane over the captured diff via a **Copilot SDK child runtime** (owned
`CopilotClient`/`RuntimeConnection`, envelope-marker output contract — structured
output is broken on Copilot CLI 1.0.83), findings parsed and rendered in-chat.
`/z-pr-review N` becomes a real review command over I2's capture. No tiers (I4), no
validation/adjudication (I5), no publication (I7).

I3 additionally owes the dev-loop:

- Replace the `runDogfood: undefined` stub in `scripts/dev-loop.mjs` with the real
  SDK-dispatched review (`--no-comment`) — the dispatched command is `/z-pr-review`
  under the new names — map validated P0/P1 findings into the review-file contract,
  and make `--dogfood on` runnable.
- **Assert at dispatch that our commands are registered with OUR descriptions** (reuse
  the `waitForCommands` name+description pattern from `tests/smoke-harness.mjs`): with
  the prototype-absent gate gone, this dispatch-time check is the real protection
  against command-name ambiguity — sibling plugins may be registered at any time.
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
