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
yourself: merging is owned by the dev-loop or the human. Do not reopen settled
decisions. If a doc is stale or ambiguous, flag it in the PR rather than deciding
silently. When finished, report: PR number, evidence (test/smoke results), flagged
decisions.
