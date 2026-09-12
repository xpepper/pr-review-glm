Execute the {INCREMENT} increment of the pr-review-glm project — a GitHub Copilot CLI
plugin porting pi-pr-review's PR-review workflow, built in small, dogfooded increments.

Read AGENTS.md first, then HANDOFF.md, ROADMAP.md, and the design specs they link to.
Verify git state and open PRs against what HANDOFF.md records before doing anything.

Then execute the {INCREMENT} increment, following the per-increment workflow in
AGENTS.md: keep the scope small, produce the evidence ROADMAP.md requires, update
ROADMAP.md (status + journey log) and rewrite HANDOFF.md for the next session in the
same PR. When rewriting HANDOFF.md, place a machine-owned status line directly under
the H1 title: `STATUS: next=<next-increment-id>` (use `STATUS: blocked: <one-line
reason>` if you cannot complete; `STATUS: done` after the final increment).

Land the increment as a pull request — never push to main, and NEVER merge the PR
yourself: merging is owned by the dev-loop or the human. Never create or push
release tags (`vX.Y.Z`) either: version tags are created by the loop's merge
path on merged main AFTER the PR merges — a tag pushed from your branch lands
on the pre-squash branch head, collides with the loop's own tag, and stops the
run (observed 2026-09-12: a pre-pushed `v0.2.1` pointed at the branch head and
the C1 merge's tagging step died on the collision). Bump `plugin.json` in the
PR; the loop does the tagging. Do not reopen settled
decisions. If a doc is stale or ambiguous, flag it in the PR rather than deciding
silently.

Loop↔plugin protocol surfaces — the `STATUS:` grammar, the `/z-pr-review`
command descriptions, and the machine-summary shape the dogfood reviewer parses
— are validated by the RUNNING loop's code imported from main, which cannot see
changes inside your PR. Never change them in your increment PR: keep the
registered description text and summary fields exactly as main has them, and if
the increment genuinely needs a protocol change, leave it OUT of the PR, say so
in the PR description and HANDOFF, and let the supervisor land it on main first
(see the dev-loop spec's Amendments, 2026-09-11).

When finished, report: PR number, evidence (test/smoke results), flagged
decisions.
