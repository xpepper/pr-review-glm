# pr-review-glm

This repository hosts **z-pr-review**, a GitHub Copilot CLI plugin that ports the review
workflow of [pi-pr-review](https://github.com/10ego/pi-pr-review) — parallel, tiered AI
code review of GitHub pull requests with host-validated findings and gated publication —
for personal use. (The plugin identity was renamed to z-pr-review by R1; the repository
keeps its original name.)

**Status: pre-alpha (increment I2 + R1 rename).** `/z-pr-review status|help`,
`/z-pr-review N --capture-only` (read-only PR capture via `gh`: metadata, base/head,
diff — no model calls), and `/z-pr-review-config` work. No reviews yet — see
[ROADMAP.md](ROADMAP.md) for what's next. This README evolves with the tool.

## What it will do

`/z-pr-review 123` captures the PR with `gh`, runs focused reviewer lanes in parallel on
configured light/medium/heavy models (quick / balanced / full / deep topologies),
validates and adjudicates candidate findings in code, renders a structured report
(severity P0–P3/nit, blocking, confidence, diff-anchored locations), and — only when
explicitly authorized — publishes one gated `COMMENT` review with validated inline
comments. All authority (topology, budgets, publication gates) is code-owned; model
output never selects what gets posted.

Design details: [design spec](docs/superpowers/specs/2026-09-09-copilot-pr-review-port-design.md).

## How it's built

Small, sequential increments, each landing as a pull request — and, from the first
working review onward, **reviewed by this tool itself** before merging (dogfooding).
`main` is protected: every change arrives by PR.

## Install (personal use)

From the public marketplace (two commands; installs from THIS repository, pinned to the
release tag named by the marketplace entry — no `--experimental` needed for
marketplace-installed plugins on Copilot CLI 1.0.83):

```sh
copilot plugin marketplace add xpepper/copilot-plugins
copilot plugin install z-pr-review@xpepper-copilot-plugins
```

The marketplace ([xpepper/copilot-plugins](https://github.com/xpepper/copilot-plugins))
is a generic index of the author's Copilot plugins: it holds only the manifest + README,
and each entry references the plugin's own repository. `copilot plugin update
z-pr-review` follows the entry's pinned tag when a new release lands.

Local development from a checkout instead (needs `--experimental`; start a fresh session
after edits — and `copilot plugin uninstall z-pr-review` first if the marketplace copy is
installed, or the same commands register twice and dispatch is ambiguous; this applies to
running the `tests/smoke-*.mjs` scripts from a normal shell too. Verify with
`copilot plugin list`):

```sh
copilot --plugin-dir /path/to/pr-review-glm --experimental
```

`/z-pr-review` shows the capability boundary and running version, `/z-pr-review N`
reviews PR N (see [ROADMAP.md](ROADMAP.md) for the current surface), and
`/z-pr-review-config` manages configuration.

## Repository map

- [AGENTS.md](AGENTS.md) — working guide for agents/humans (principles, workflow, conventions)
- [HANDOFF.md](HANDOFF.md) — instructions for the next session (rewritten every increment)
- [ROADMAP.md](ROADMAP.md) — increment plan, status, journey log, backlog
- [docs/superpowers/specs/](docs/superpowers/specs/) — design spec
- [docs/research/](docs/research/) — upstream architecture map, Copilot CLI extensibility notes
- [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md) — upstream code reuse and attribution

## License & attribution

New code in this repository: MIT — see [LICENSE](LICENSE).
Code ported from upstream pi-pr-review (MIT-declared) is attributed in
[docs/ATTRIBUTION.md](docs/ATTRIBUTION.md).
