# HANDOFF.md — instructions for the next session

Written for a **fresh session** continuing this project. This file is rewritten at the
end of every increment; it is the single source of "where we stopped".

Read in order: `AGENTS.md` → this file → `ROADMAP.md` → the
[design spec](docs/superpowers/specs/2026-09-09-copilot-pr-review-port-design.md).
Check `git status`, recent PRs (all merged except none expected), and that local `main`
matches `origin/main` before starting. Do not rely on any prior conversation's context.

## Recorded state (2026-09-09, end of I1 session)

- `main` = I1 complete (plugin skeleton + configuration), assuming PR #3 merges. Working
  tree clean. No open PRs should remain.
- I1 shipped: `plugin.json` (name `pr-review-glm`), `extensions/pr-review/extension.mjs`
  (`joinSession`, registers `/pr-review status|help` and `/pr-review-config
  show|key=value|unset|help`), `extensions/pr-review/config.mjs` (schema-versioned
  config at `~/.copilot/pr-review-glm/config.json`, whole-object validation, atomic
  0600 writes, rejected-file protection), `extensions/pr-review/commands.mjs` (pure
  parsing/rendering), MIT `LICENSE`.
- Tests: `node --test tests/*.test.mjs` (46 tests). Smoke: `node tests/smoke-i1.mjs`
  (spawns a fresh CLI session via the SDK with `--plugin-dir "$(pwd)" --experimental`,
  dispatches commands by RPC, asserts zero inference events; snapshots/restores the
  user's config file). Both must pass before any increment merges.
- The prior `copilot-pr-review` prototype is **uninstalled** (same command names caused
  ambiguous dispatch). Its source checkout at `~/Documents/workspace/ai/pr-review` is
  untouched: runtime-facts reference only, never a code source.
- Config schema details chosen in I1 (flagged in PR #3, not settled by the spec):
  tier `model: null` means "use the session model at review time"; `fallback` is a
  model-id string (same effort as its tier) and must differ from the tier's model;
  `unset` resets a key to its default value (optional keys like `fallback` are removed);
  deadline validation enforces `totalMs > batchMs`, `> max(attemptMs.*)`,
  `> adjudicationMs`.

## Next increment: I2 — read-only PR capture

Definition of done (from ROADMAP; spec §Components 3 for details):

1. `/pr-review N --capture-only` (extend `parseReviewArgs`): fetch PR metadata, base/head
   info, and diff via `gh` (authenticated, fail-closed on errors), write the capture to a
   0600 temp file, freeze the repo/PR binding at capture time.
2. Draft/closed lifecycle gates: drafts skipped unless `--include-drafts`; closed/merged
   require `--include-closed` (no interactive confirmation needed for `--capture-only`).
3. Fail-closed consistency checks: capture refuses on inconsistent repo/head state,
   empty diff, or unauthenticated `gh`.
4. Zero inference: capture is pure code (`gh` subprocess + parsing); extend the smoke
   script (or add `tests/smoke-i2.mjs`) proving a real PR captures without any model
   events. Demonstrate against a real PR on this repo (e.g. the I2 PR itself once open).
5. Update `ROADMAP.md` (I2 → ✅ with evidence) and rewrite this file for I3.

Boundaries: no lanes, no model calls, no publication. `renderStatus` should learn to
report capture state. Reuse the smoke-script harness pattern (`runCommand` +
no-inference assertion) rather than inventing a second one.

## After I2

I3 — first minimal review (dogfood entry point): one heavy lane over the captured diff
via a Copilot SDK child runtime with the envelope-marker contract. From I3 on, every
increment PR is reviewed by this tool before merge; findings stay local unless the user
says post. The upstream LICENSE issue (see `docs/ATTRIBUTION.md`) must be filed before
I4+ reuse — not needed for I2/I3.
