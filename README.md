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

Load locally from a checkout (extensions need `--experimental` for now; start a fresh
session after edits):

```sh
copilot --plugin-dir /path/to/pr-review-glm --experimental
```

`/z-pr-review` shows the capability boundary, `/z-pr-review N --capture-only` captures a
PR read-only (needs an authenticated `gh`), and `/z-pr-review-config` manages
configuration. Reviews arrive with later increments.

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
