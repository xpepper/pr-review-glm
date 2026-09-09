# HANDOFF.md — instructions for the next session

Written for a **fresh session** continuing this project. This file is rewritten at the
end of every increment; it is the single source of "where we stopped".

Read in order: `AGENTS.md` → this file → `ROADMAP.md` → the
[design spec](docs/superpowers/specs/2026-09-09-copilot-pr-review-port-design.md).
Check `git status`, recent PRs (all merged except none expected), and that local `main`
matches `origin/main` before starting. Do not rely on any prior conversation's context.

## Recorded state (2026-09-09, end of session)

- `main` = I0 complete. PRs #1 (spec + principles) and #2 (project context) are merged;
  no other PRs should exist. Working tree clean.
- Repo is **public**: https://github.com/xpepper/pr-review-glm. `main` is protected:
  PRs required, zero approvals needed, admins bound, force pushes disabled.
  (Classic branch protection — the rulesets API rejected the equivalent payload.)
- Prior prototype `copilot-pr-review` remains installed and **enabled** at
  `~/.copilot/installed-plugins/_direct/pr-review`; it registers `/pr-review` too.
  It must be disabled before dogfooding this plugin in a live session
  (`copilot plugins disable` or uninstall; its checkout stays untouched).
- Upstream LICENSE issue (pi-pr-review declares MIT, ships no LICENSE file) has **not**
  been filed yet — file it when first reusing upstream code (I4+), see
  `docs/ATTRIBUTION.md`.

## Next increment: I1 — plugin skeleton + configuration

Definition of done (from ROADMAP; spec §Components for details):

1. `plugin.json` (name `pr-review-glm`, `extensions: ["./extensions"]`) and
   `extensions/pr-review/extension.mjs` using `joinSession` from
   `@github/copilot-sdk/extension`, registering:
   - `/pr-review` with subcommands `status` (capability boundary, default when run
     bare) and `help` — **no model calls**;
   - `/pr-review-config` with `show`, `key=value …`, `unset key …`.
2. `extensions/pr-review/config.mjs`: read/validate/write
   `~/.copilot/pr-review-glm/config.json`, schema-versioned, mode 0600; keys:
   `tiers` (`light|medium|heavy` → `{model, effort, fallback?}`), `defaultMode`
   (`balanced`), `autoPostReviews` (false), `deadlines` (spec defaults). Validate the
   whole object as a unit; reject partial/malformed with the last valid state kept.
3. `tests/` no-inference smoke script: load the plugin via
   `copilot --plugin-dir "$(pwd)" --experimental` in a fresh session and prove both
   commands appear and a config set/show/unset round-trip works without inference.
4. Update `ROADMAP.md` (I1 → ✅ with evidence) and rewrite this file for I2.

Boundaries: no PR capture, no lanes, no model calls, no upstream code needed. Don't
re-open settled decisions (AGENTS.md). If the extension API surface differs from the
research notes (it's experimental and moving), adapt and record the delta in AGENTS.md.

## After I1

I2 — read-only PR capture (`--capture-only`), per ROADMAP. The first dogfood-eligible
review is I3; from I3 onward every increment PR must be reviewed by this tool before
merge (its review output goes in the PR; findings stay local unless the user says post).
