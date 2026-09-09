# Design: Porting pi-pr-review to GitHub Copilot CLI

Date: 2026-09-09
Status: approved in conversation; amended with development-approach principles (this PR); pending user review
Repo: `pr-review-glm` → https://github.com/xpepper/pr-review-glm (private)

## Context and goal

[pi-pr-review](https://github.com/10ego/pi-pr-review) (v1.18.1, [pi.dev package page](https://pi.dev/packages/pi-pr-review)) is a pi coding agent extension providing parallel, model-agnostic AI code review of GitHub pull requests: tiered reviewer lanes as isolated headless `pi` subprocesses, host-validated findings, deterministic degraded fallbacks, and host-gated GitHub publication.

This project ports that review workflow to **GitHub Copilot CLI** (1.0.83 at design time) as a **personal-use plugin** in this repository. Research notes: [`docs/research/pi-pr-review-architecture.md`](../../research/pi-pr-review-architecture.md) (upstream map) and [`docs/research/copilot-cli-extensibility.md`](../../research/copilot-cli-extensibility.md) (platform capabilities).

A prior clean-room prototype (`copilot-pr-review`, installed at `~/.copilot/installed-plugins/_direct/pr-review`) demonstrated the Copilot runtime patterns this design relies on. It is **not** the base for this port; it is a reference for platform facts.

## Settled decisions

| Decision | Choice |
|---|---|
| V1 scope | Parallel lanes + structured report + gated COMMENT publication (inline comments, single POST). APPROVE machinery stubbed out. |
| Packaging | Personal use, plugin-shaped: `plugin.json` in this repo, installed by local path; `OWNER/REPO` installability later. |
| Models | Keep light/medium/heavy tiers (model + reasoning effort per tier, one fallback each), stored in the port's own config. |
| Relation to prior prototype | Fresh port; prototype consulted for runtime facts only. |
| Architecture | Code-owned orchestrator in a plugin extension; reviewer lanes as Copilot SDK child runtimes. |
| Upstream licensing | Upstream declares MIT in `package.json` but ships no LICENSE file. We reuse source with clear attribution (`docs/ATTRIBUTION.md`) and open an upstream issue/PR requesting the missing LICENSE file. |

## Development approach (core principles)

Two principles govern how this port is built; they override convenience in every planning decision:

1. **Small, sequential increments.** The tool grows from the ground up in small increments, each independently developable and demonstrable, tested as we go. No big upfront build: we validate that we like each layer (capture, lanes, adjudication, publication) before investing in the next.
2. **Dogfood from the first reviewable increment.** Every increment lands as a pull request on [xpepper/pr-review-glm](https://github.com/xpepper/pr-review-glm) (pushed on day one for this purpose) and is merged only after review — by this tool itself as soon as it can run a minimal review end-to-end, by conventional review before that. `main` is never pushed to directly; branch-protection enforcement is currently unavailable (private repo on a free plan) so the no-direct-push rule is by convention until the repo goes public or the plan upgrades.

Consequences for planning: the implementation plan must be a sequence of small increments, each shipping on a branch → PR → review → merge; and the increment ordering must prioritize the first end-to-end minimal review (capture + one lane + report, no publication) so dogfooding starts as early as possible, with depth (more lanes, tiers, adjudication, gates, publication) added in later increments.

## Architecture

Approach A (approved over a prompt-orchestrator port and an MCP-centric core): the extension's code owns the entire pipeline deterministically. The session LLM never orchestrates; models run only inside reviewer lanes and one adjudicator call. Upstream's 250-line orchestrator prompt survives as lane objective prompts and the adjudicator prompt.

### Why (evidence base)

- The prototype proved on CLI 1.0.83: structured output is unusable (feature-flagged; permission-handler conflict) → **envelope-marker parsing works**; reviewer children run via the GA Copilot SDK (`CopilotClient`/`RuntimeConnection`) with a **permission handler confining read-only tools** (`view`, `rg`, `glob`) to chosen directories; tool grants on custom agents leak (`skill`, `sql`) — avoid agent-declared grants.
- Verified locally: `copilot -p --output-format json` emits a JSONL event stream (`assistant.message` with final content and tool requests, `model.call_finished`, `session.usage_checkpoint` with credit/token usage); plugins and their commands load headlessly.
- Extensions require `--experimental` today; `--plugin-dir <path>` loads a plugin locally; `--model` and `--effort none|minimal|low|medium|high|xhigh|max` exist (mirroring pi's thinking levels).
- Upstream `lib/` modules (markdown, publish, deadlines, concurrency, context, artifacts, prior, telemetry) are pi-free TypeScript and port mechanically; `gh` usage is unchanged.

## Package layout

```
pr-review-glm/
├── plugin.json                  # name: pr-review-glm; extensions: ./extensions
├── extensions/pr-review/
│   ├── extension.mjs            # joinSession entry: /pr-review, /pr-review-config
│   ├── lanes.mjs                # Copilot SDK child runtimes per reviewer lane
│   ├── capture.mjs              # gh-based PR capture + large-diff transport
│   ├── adjudicate.mjs           # isolated adjudicator call + candidate validation
│   ├── report.mjs               # in-chat findings rendering + retained-result inspect
│   ├── publish.mjs              # gated COMMENT publication
│   └── config.mjs               # config load/validate/update
├── lib/                         # ported from upstream (attribution in docs/ATTRIBUTION.md)
├── tests/                       # unit tests + no-inference smoke scripts
└── docs/                        # research notes, ATTRIBUTION.md, this spec
```

## Components

1. **`extension.mjs`** — registers `/pr-review` and `/pr-review-config` as code-owned commands via `joinSession`. Owns the review coordinator: one active review per session, progress streamed to the chat timeline (`session.log`), finding selection via native elicitation. New user input or cancellation aborts lanes.
2. **`lanes.mjs`** — one Copilot SDK child runtime per lane: tier model/effort, read-only tools (`view`, `rg`, `glob`) confined by permission handler to the captured source, envelope output contract (`<<<REVIEW_BEGIN>>> … <<<REVIEW_END>>>`, one whole-response fence unwrapped; markers/fences count only as whole lines). Attempt budgets, one bounded fallback attempt per lane on retryable failure, cancellation propagation.
3. **`capture.mjs`** — `gh pr view`/`gh pr diff` into a 0600 temp file; repo/PR binding frozen at start; draft/closed gates with confirmation; diffs ≥200,000 bytes switch to file-backed transport (changed-file manifest + required read ranges; completeness enforced from tool events), ported from upstream `pr-review-context`/artifact logic.
4. **`adjudicate.mjs`** — host-side deterministic validation (severity ladder, blocking rules, anchor-vs-diff checks, evidence quotes), then one isolated adjudicator model call (heavy tier, envelope contract) merging/deduplicating/classifying candidates. This carries upstream's Step-7 validation methodology.
5. **`report.mjs`** — findings table + sections in-chat (severity, blocking, confidence, diff-anchored location); retained result inspectable without inference or GitHub access.
6. **`publish.mjs`** — gated COMMENT publication (below). `approveMaxPriorityLevel` reserved in config with value `off`; APPROVE code path stubbed.
7. **`config.mjs`** — `~/.copilot/pr-review-glm/config.json` (schema-versioned; deliberately a different path from the prior prototype's `~/.copilot/pr-review/config.json` to avoid cross-reading its schema): tier models/efforts + fallbacks, default mode, `autoPostReviews`, deadlines. `/pr-review-config show | key=value | unset`. User scope only in v1.

## Review pipeline

`/pr-review 123 [--quick|--balanced|--full|--deep] [--comment|--no-comment] [--all] [--include-closed|--include-drafts] [--capture-only]`

Mode topologies (fixed, code-owned; ids validated exactly like upstream):

| Mode | Lanes | Findings policy |
|---|---|---|
| `--quick`/`--major-only` | 3 heavy: correctness, contracts, security/performance/resources | P0–P2 only |
| `--balanced` (default) | 4 heavy specialists + 1 light overview | P0–P2 + ≤3 direct-diff P3/nit |
| `--full` | balanced + 1 medium conventions/maintainability | all qualifying severities |
| `--deep` | 1 integrated heavy, whole-PR | all substantiated severities |

Flow: parse flags → load config → capture (fail-closed; `--capture-only` stops here, no lanes, no inference) → draft/bot skip with `--include-drafts` override, closed/merged PRs require confirmation or `--include-closed` → spawn lanes concurrently with per-lane progress → envelope-wrapped candidate findings → deterministic validation → adjudicator merge/dedup → render report → elicitation selection (validated selection default; `--all`, subset, or none; when `autoPostReviews` publishes without an interactive selection, the validated default selection is published) → publish gated COMMENT when `--comment` or `autoPostReviews` → retain settled result in-session (`/pr-review inspect`, `/pr-review publish` later).

Severity model unchanged from upstream: P0/P1 blocking, P2/P3/nit non-blocking; verdict `request_changes` only with validated P0/P1 (reported in-chat; GitHub verdict is always COMMENT in v1).

## Publication gates

- Authority: only `--comment` or `autoPostReviews: true` (or explicit `/pr-review publish` on the retained result, added post-v1). Captured before lanes start; model text never selects event, commit, repo, or anchors.
- Before the single `POST repos/{repo}/pulls/N/reviews`: stale-head check (stale → body-only naming both commits), draft/lifecycle, self-author, per-target write serialization, final head re-check.
- Inline: first 50 findings whose anchors validate against `pulls/N/files` hunks; remainder to `Other Notes`. Concise body + idempotency marker; oversized → fail closed.
- No validated findings → no POST. Uncertain write response → reconcile by scanning existing reviews for the marker.

## Degradation and budgets

- Lane lifecycles: `complete` / `partial` / `timed_out` / `failed`, classified from child events; clean exit without a satisfied output contract is incomplete. Incomplete coverage is always disclosed; incomplete lanes can never yield a clean-review claim.
- Degraded runs (incomplete lanes, malformed adjudication): deterministic host-rendered report with coverage disclosure; COMMENT-only if published; raw lane text retained internally.
- Budgets (defaults from upstream, all configurable): attempt caps 3m light / 6m medium / 12m heavy; one fallback attempt ≤3m on retryable failure; batch 12m from first dispatch; adjudication 60s; total 15m hard cap including cleanup. Total expiry stops queued lanes; completed/partial artifacts still flow to degraded synthesis.

## Error handling

Capture fails closed on inconsistent repo/head, empty diff, or unauthenticated `gh`. Lane spawn/transport failures fall back once, then classify `failed` and continue with disclosure. Config is validated as a unit; partial/malformed files are rejected with the last valid state active. Extension loss (parent exit) terminates owned child runtimes.

## Testing

1. **Unit tests** for `lib/` and gates: port upstream tests where pi-free (markdown parsing incl. degraded cases, publish gates, budget math, anchor validation); new tests for envelope unwrapping (including adversarial payload text containing markers/fences).
2. **No-inference smoke scripts** (prototype pattern): startup/config/capture-only against a fixture repo; lane transport ping without a model prompt.
3. **Dogfooding**: real PRs with `--no-comment` first; this repository's own PRs reviewed by the tool as the integration test (the prototype's practice).

## Out of scope for v1 (explicit)

Incremental re-review (`--incremental`, `pr_review_prior`); verification profiles; self-review; TUI focus viewer (progress lives in the chat timeline); experimental finding extraction; cross-session persistence of retained results; APPROVE publication; project-trust config overrides; semantic benchmark suite; marketplace publication.

## Open items

1. Open upstream issue/PR to add the missing LICENSE file (reuse proceeds meanwhile, with attribution).
2. Installing this plugin requires disabling/uninstalling the prior prototype (same `/pr-review` command names); the old checkout stays on disk untouched.
3. `--experimental` requirement for extensions documented as an install step.
4. Lane tool surface starts as `view`/`rg`/`glob` (prototype-proven); upstream's broader allowlist (`bash`, `find`, `ls`) deferred.

## Attribution

Upstream code reused under its declared MIT license (package.json) with attribution in `docs/ATTRIBUTION.md`, listing the upstream repository, version/commit pinned at port time, and the modules reused.
