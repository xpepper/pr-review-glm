Fix review findings on pull request #{PR_NUMBER} of the repo at {REPO_ROOT}
(branch {HEAD_REF}, already checked out — work on that branch, never main).

Findings (JSON): {FINDINGS_JSON}

Address every P0 and P1 finding; fix P2s when clearly right, otherwise note why not.
Follow AGENTS.md conventions. When done, re-run `node --test tests/*.test.mjs` and the
applicable smoke scripts, push to the branch, and post a PR comment summarizing what
you fixed. Do NOT merge. Do not expand scope beyond the findings.
