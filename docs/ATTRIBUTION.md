# Attribution

This project ports the review workflow of
[pi-pr-review](https://github.com/10ego/pi-pr-review) (npm `pi-pr-review`, by 10ego) to
GitHub Copilot CLI. Its design and portions of its host-side libraries are derived from
that project.

## Upstream licensing state (recorded 2026-09-09)

- `pi-pr-review` declares `"license": "MIT"` in its `package.json`.
- The repository ships **no standalone LICENSE file** at the inspected revision
  (v1.18.1). An upstream issue/PR requesting the file is planned before or with the
  first source reuse (increments I4+; not yet filed).

Policy: reuse upstream source under its declared MIT license with this file recording
exactly what was reused, from which version and commit. Until the LICENSE file lands
upstream, keep reuse to the pi-free `lib/` modules and record everything below. Do not
copy code from the prior `copilot-pr-review` prototype (clean-room, reference only).

## Reused upstream code

None yet — no upstream source has been copied into this repository. When the first
module is ported, append one row per module:

| Module (here) | Upstream module | Upstream version | Upstream commit | Notes |
|---|---|---|---|---|
| — | — | — | — | — |

## Derived works

- `docs/research/pi-pr-review-architecture.md` — an independent architecture summary of
  upstream v1.18.1 (our writing, informed by reading upstream source).
- The design spec's behavioral requirements derive from upstream's documented behavior
  (README, prompts) — facts, not copied text.
