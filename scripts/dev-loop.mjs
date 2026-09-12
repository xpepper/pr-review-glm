#!/usr/bin/env node
// dev-loop: script-orchestrated increment loop (spec:
// docs/superpowers/specs/2026-09-10-dev-loop-design.md).
// The loop owns sequencing, gates, and merging; every judgment phase is a fresh
// headless zcode invocation; nothing an agent claims is trusted without a gate.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseStatusLine, roadmapIncrementState } from "./dev-loop/status.mjs";
import { buildPhaseEnv, PHASE_LIMITS, buildZcodeArgs, persistPhaseOutput, renderPrompt, resolveZcodeCli, runCommand } from "./dev-loop/phases.mjs";
import {
  gateBranchHead, gateDocsUpdated, gateMainGreen, gateRepoIdle,
  gateSmokes, gateTests, gateZcodeHeadless, isFullOid, mergeabilityGate, reportGates,
} from "./dev-loop/gates.mjs";
import { runLoop } from "./dev-loop/loop.mjs";
import { gateVersionBump, verifyBumpAtMerge } from "./dev-loop/version.mjs";
import { deleteMergedBranch, mergeTail, squashMergeAtHead } from "./dev-loop/merge-tail.mjs";
import { runDogfoodReview } from "./dev-loop/dogfood.mjs";
import { findResumablePr, recoverCheckout } from "./dev-loop/resume.mjs";

const repoRoot = process.cwd();
const artDir = join(repoRoot, ".dev-loop");

function parseArgs(argv) {
  const options = { maxIterations: 1, cooldownSeconds: 60, dryRun: false, dogfood: false, mergeMode: "human" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--max-iterations") options.maxIterations = Number(argv[++i]);
    else if (arg === "--cooldown-seconds") options.cooldownSeconds = Number(argv[++i]);
    else if (arg === "--dogfood") {
      const value = argv[++i];
      if (value !== "on" && value !== "off") {
        console.error("--dogfood requires an explicit on|off value");
        process.exit(2);
      }
      options.dogfood = value === "on";
    }
    else if (arg === "--merge") {
      const value = argv[++i];
      if (value !== "human" && value !== "auto") {
        console.error("--merge requires an explicit human|auto value");
        process.exit(2);
      }
      options.mergeMode = value;
    }
    else if (arg === "--help") { printUsage(); process.exit(0); }
    else { console.error(`unknown argument: ${arg}`); printUsage(); process.exit(2); }
  }
  if (!(options.maxIterations >= 1) || !(options.cooldownSeconds >= 0)) {
    console.error("--max-iterations must be an integer >= 1; --cooldown-seconds an integer >= 0");
    process.exit(2);
  }
  // From I3, the loop merges only heads the plugin's own review assessed
  // (spec, L2 amendment): auto without the dogfood review refuses to run.
  if (options.mergeMode === "auto" && !options.dogfood) {
    console.error("--merge auto requires --dogfood on: the loop merges only heads the plugin's own review assessed");
    process.exit(2);
  }
  return options;
}
function printUsage() {
  console.log("usage: node scripts/dev-loop.mjs [--max-iterations N] [--cooldown-seconds S] [--dry-run] [--dogfood on|off] [--merge human|auto]");
}

const read = (path) => readFileSync(join(repoRoot, path), "utf8");

function statusGate() {
  const status = parseStatusLine(read("HANDOFF.md"));
  const roadmap = read("ROADMAP.md");
  if (status.kind === "next") {
    const state = roadmapIncrementState(roadmap, status.increment);
    if (state !== "pending") {
      return { name: "status", ok: false, detail: `STATUS next=${status.increment} but ROADMAP says "${state}"` };
    }
    return { name: "status", ok: true, detail: `next=${status.increment} (pending in ROADMAP)`, status };
  }
  if (status.kind === "done" || status.kind === "blocked") {
    return { name: "status", ok: true, detail: `${status.kind}${status.reason ? `: ${status.reason}` : ""} — loop will stop`, status };
  }
  return { name: "status", ok: false, detail: `HANDOFF STATUS is ${status.kind}: ${status.line ?? ""}`.trim(), status };
}

async function dryRun(options) {
  console.log(`DRY-RUN: gates only, no agent phases, nothing mutates. (merge=${options.mergeMode}, dogfood=${options.dogfood ? "on" : "off"})`);
  const results = [];
  const status = statusGate();
  results.push(status);
  const run = (command, args, opts) => runCommand(command, args, opts);
  results.push(await gateTests({ run, repoRoot }));
  results.push(await gateSmokes({ run, repoRoot, exclude: ["smoke-l1.mjs"] }));
  console.log(reportGates(results));
  console.log([
    "SKIPPED repo-idle (context-dependent: assumes idle main before a real iteration)",
    "SKIPPED increment-pr, docs-updated, reviews, merge, main-green (need a real iteration)",
  ].join("\n"));
  if (results.some((g) => !g.ok)) process.exit(1);
  return;
}

function loadTemplate(name) {
  return readFileSync(new URL(`./dev-loop/${name}`, import.meta.url), "utf8");
}

// One dispatch per file: worker runs once, reviewer re-runs per assessment,
// fixer per round — the index keeps every dispatch's transcript on disk.
const phaseDispatchCounts = new Map();
const nextPhaseIndex = (name) => {
  const index = (phaseDispatchCounts.get(name) ?? 0) + 1;
  phaseDispatchCounts.set(name, index);
  return index;
};

function phaseRunner({ zcode, name, template, vars, limits, phaseEnv }) {
  const prompt = renderPrompt(template, vars);
  const args = buildZcodeArgs({ prompt, repoRoot });
  const index = nextPhaseIndex(name);
  return async () => {
    const result = await runCommand(zcode, args, { cwd: repoRoot, timeoutMs: limits.timeoutMs, env: phaseEnv });
    // The transcript survives the run whatever the exit code — the 2026-09-12
    // shell-less worker's only self-report lived in stdout nobody printed.
    const persisted = persistPhaseOutput({ artDir, name, index, result });
    if (persisted.error) console.error(`[dev-loop] warning: ${persisted.error}`);
    else console.log(`[dev-loop] ${name} transcript: ${persisted.file}`);
    if (result.code !== 0 || result.timedOut) console.error(result.stdout.slice(-2000), result.stderr.slice(-2000));
    return result;
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.dryRun) return dryRun(options);
  const zcode = resolveZcodeCli();
  mkdirSync(artDir, { recursive: true });
  // Isolated phase HOME (MCP/plugins/skills cannot exist for phase agents —
  // see buildPhaseEnv): built once per run, probed by the zcode-headless
  // preflight before any phase is dispatched, removed on the way out. A build
  // failure (model config unreadable) stops before dispatching anything.
  const phase = buildPhaseEnv();
  if (phase.error) {
    const summary = { stopped: "failure", reason: `phase-env: ${phase.error}`, iterations: [] };
    console.error(`\n[dev-loop] stopped=failure reason=${summary.reason}`);
    writeFileSync(join(artDir, "report-last.json"), `${JSON.stringify(summary, null, 2)}\n`);
    process.exit(1);
  }
  try {
    await runMain(options, { zcode, phaseEnv: phase.env });
  } finally {
    phase.cleanup();
  }
}

async function runMain(options, { zcode, phaseEnv }) {
  const run = (command, args, opts) => runCommand(command, args, opts);
  const log = (line) => console.log(`[dev-loop] ${line}`);
  // Every gate result prints as it completes — a silent multi-minute gate batch
  // (tests + smokes can run 5+ minutes) is indistinguishable from a hang from
  // the terminal (the I3 run #2 lesson, now applied to gates as well as phases).
  const logGate = (gate) => { log(`gate ${gate.name}: ${gate.ok ? "PASS" : "FAIL"} — ${gate.detail}`); return gate; };
  // A previous run may have stopped mid-iteration (gate failure, killed
  // process), leaving the checkout stranded on the increment branch: recover to
  // synced main before anything reads HANDOFF — fail-closed on debris we cannot
  // safely move (dirty tree, git failures) instead of dispatching phases.
  const recovery = await recoverCheckout({ run, repoRoot });
  if (recovery) {
    if (recovery.ok) console.log(`[dev-loop] ${recovery.detail}`);
    else {
      const summary = { stopped: "failure", reason: `${recovery.name}: ${recovery.detail}`, iterations: [] };
      console.error(`\n[dev-loop] stopped=failure reason=${summary.reason}`);
      writeFileSync(join(artDir, "report-last.json"), `${JSON.stringify(summary, null, 2)}\n`);
      process.exit(1);
    }
  }
  // The increment under work is captured from the pre-worker STATUS: after the
  // worker rewrites HANDOFF, its STATUS names the NEXT increment, which is not
  // what gateDocsUpdated must validate.
  let workedIncrement = null;

  const summary = await runLoop({
    readStatus: async () => parseStatusLine(read("HANDOFF.md")),
    preflight: async () => [
      logGate(await gateRepoIdle({ run, repoRoot })),
      // Probes the exact worker arg set AND the isolated phase env: if the
      // phase HOME breaks model config or auth, this fails in seconds.
      logGate(await gateZcodeHeadless({ run, zcode, repoRoot, env: phaseEnv })),
      logGate(await gateTests({ run, repoRoot })),
      logGate(await gateSmokes({ run, repoRoot, exclude: ["smoke-l1.mjs"] })),
    ],
    // Mid-iteration resume (spec Amendments): recognize the checkpoint a
    // previous run left after its worker completed and skip straight to
    // assessment. On adoption no worker runs, so the increment under work is
    // this one — the resumed PR already carries its docs rewrite.
    findResumablePr: async (status) => {
      const adopt = await findResumablePr({ run, repoRoot, increment: status.increment });
      if (adopt) workedIncrement = status.increment;
      return adopt;
    },
    runWorker: (status) => {
      workedIncrement = status.increment;
      return phaseRunner({
        zcode, name: "worker", template: loadTemplate("worker-prompt.md"),
        vars: { INCREMENT: status.increment }, phaseEnv, limits: PHASE_LIMITS.worker,
      })();
    },
    workerGates: async () => {
      const prs = await run("gh", ["pr", "list", "--state", "open", "--json", "number,headRefName,url,headRefOid,mergeable"], { cwd: repoRoot });
      let open = [];
      try { open = JSON.parse(prs.stdout || "[]"); } catch { /* gate below reports */ }
      const results = [];
      let prNumber = null;
      let headRefOid = null;
      if (prs.code === 0 && open.length === 1) {
        prNumber = open[0].number;
        headRefOid = open[0].headRefOid ?? null;
        // Cheapest check first: a CONFLICTING PR can never merge, so it fails
        // before any local gate or review burns a cycle on it (the I4 landing
        // learned this the expensive way, at `gh pr merge` time).
        const mergeable = logGate(mergeabilityGate(open[0]));
        if (!mergeable.ok) return { results: [mergeable], prNumber, headRefOid };
        results.push(mergeable);
        // The worker may leave the checkout anywhere; gates and the reviewer must
        // see the exact PR head, so establish it before anything runs (zero-trust:
        // never assume the worker left it there or that it matches the remote
        // head the pin records).
        const branchHead = logGate(await gateBranchHead({ run, repoRoot, headRefName: open[0].headRefName, headRefOid }));
        if (!branchHead.ok) return { results: [branchHead], prNumber, headRefOid };
        results.push(branchHead);
        results.push(logGate(await gateTests({ run, repoRoot })));
        // V1: every merged increment bumps plugin.json's version — checked
        // BEFORE the inference-consuming smokes so a bump-less PR fails in
        // seconds instead of after burning model calls (round-2 dogfood P2).
        results.push(logGate(await gateVersionBump({ run, repoRoot })));
        results.push(logGate(await gateSmokes({ run, repoRoot, exclude: ["smoke-l1.mjs"] })));
        results.push(logGate(await gateDocsUpdated({ readFileSync, repoRoot, increment: workedIncrement })));
      } else {
        results.push(logGate({ name: "increment-pr", ok: false, detail: `expected exactly one open PR, found ${open.length}` }));
      }
      return { results, prNumber, headRefOid };
    },
    runReviewer: async (prNumber) => {
      try {
        const pr = await run("gh", ["pr", "view", String(prNumber), "--json", "headRefName"], { cwd: repoRoot });
        const headRefName = JSON.parse(pr.stdout || "{}").headRefName ?? "";
        const reviewFile = join(artDir, "review-independent.json");
        // Invalidate any previous verdict first: a reviewer that exits 0 without
        // writing the file must surface as a missing review, not a stale approve.
        rmSync(reviewFile, { force: true });
        const invocation = await phaseRunner({
          zcode, name: "reviewer", template: loadTemplate("reviewer-prompt.md"),
          vars: { PR_NUMBER: prNumber, REPO_ROOT: repoRoot, HEAD_REF: headRefName, REVIEW_FILE: reviewFile },
          phaseEnv, limits: PHASE_LIMITS.reviewer,
        })();
        let review = null;
        try { review = JSON.parse(readFileSync(reviewFile, "utf8")); } catch { /* reviewBlocking treats null as fatal */ }
        return { ...invocation, review };
      } catch (error) {
        // Wiring failures (gh/JSON.parse) must not escape runLoop: report them as
        // an invocation failure so the loop stops with a written report.
        return { code: 1, stdout: "", stderr: String(error), timedOut: false, review: undefined };
      }
    },
    runDogfood: async (prNumber) => {
      const result = await runDogfoodReview({
        prNumber, repoRoot, timeoutMs: PHASE_LIMITS.dogfood.timeoutMs, log,
      });
      // The dogfood is not a phaseRunner invocation, but its stdout — the full
      // in-chat review the plugin rendered — is exactly what a post-mortem
      // wants on disk next to the phase transcripts.
      const persisted = persistPhaseOutput({ artDir, name: "dogfood", index: nextPhaseIndex("dogfood"), result });
      if (persisted.error) log(`warning: ${persisted.error}`);
      else log(`dogfood transcript: ${persisted.file}`);
      return result;
    },
    runFixer: async (prNumber, findings) => {
      try {
        const pr = await run("gh", ["pr", "view", String(prNumber), "--json", "headRefName"], { cwd: repoRoot });
        const headRefName = JSON.parse(pr.stdout || "{}").headRefName ?? "";
        const checkout = await run("git", ["checkout", headRefName], { cwd: repoRoot });
        if (checkout.code !== 0) {
          return { code: checkout.code, stdout: checkout.stdout, stderr: checkout.stderr, timedOut: false };
        }
        return phaseRunner({
          zcode, name: "fixer", template: loadTemplate("fixer-prompt.md"),
          vars: { PR_NUMBER: prNumber, REPO_ROOT: repoRoot, HEAD_REF: headRefName, FINDINGS_JSON: JSON.stringify(findings) },
          phaseEnv, limits: PHASE_LIMITS.fixer,
        })();
      } catch (error) {
        return { code: 1, stdout: "", stderr: String(error), timedOut: false };
      }
    },
    // Head pinning (spec, architecture step 7): the loop re-fetches the PR head
    // immediately before merging and refuses on gh failure or a malformed OID —
    // a merge must never race ahead of the pin check.
    fetchPrHead: async (prNumber) => {
      try {
        const pr = await run("gh", ["pr", "view", String(prNumber), "--json", "headRefOid"], { cwd: repoRoot });
        let headRefOid = null;
        try { headRefOid = JSON.parse(pr.stdout || "{}").headRefOid ?? null; } catch { /* error below */ }
        if (pr.code !== 0 || !isFullOid(headRefOid)) {
          return { error: `gh pr view headRefOid failed: ${(pr.stderr || pr.stdout || "").slice(0, 200)}` };
        }
        return { headRefOid };
      } catch (error) {
        return { error: String(error) };
      }
    },
    merge: async (prNumber, expectedHeadRefOid) => {
      // The loop passes the reviewed head OID it pinned; the merge path must
      // hold that same OID (gh pr merge cannot pin one itself), otherwise it
      // could integrate a head nobody re-checked.
      if (!isFullOid(expectedHeadRefOid)) {
        return { code: 1, stdout: "", stderr: `merge requires the pinned reviewed head OID for PR ${prNumber} (got ${String(expectedHeadRefOid)})`, timedOut: false };
      }
      // V1 pre-merge bump re-check: the gate's origin/main baseline was read at
      // assessment time; re-verify against a fresh main so a release landing in
      // between cannot turn this PR's bump into an unchanged version (the
      // version-side twin of the headRefOid pin).
      const bump = await verifyBumpAtMerge({ run, repoRoot, prNumber, expectedHeadRefOid });
      if (!bump.ok) return { code: 1, stdout: "", stderr: bump.detail, timedOut: false };
      log(`merge: ${bump.detail}`);
      // gh pr merge cannot pin a head, so the local pin above can lose a race;
      // the GraphQL mutation enforces the reviewed head atomically at GitHub.
      const merged = await squashMergeAtHead({ run, repoRoot, prNumber, expectedHeadRefOid });
      if (merged.code !== 0) {
        // The mutation was refused atomically, so the merge did not happen —
        // release the tag reservation verifyBumpAtMerge just took, or the
        // version stays stranded (every later run would abort on the reserved
        // tag). A failed release is disclosed as a warning on the refusal; the
        // reservation is ours alone to delete.
        const released = await run("git", ["push", "origin", "--delete", `refs/tags/${bump.tag}`], { cwd: repoRoot });
        if (released.code !== 0) {
          return { ...merged, stderr: `${merged.stderr}\nwarning: could not release the reserved tag ${bump.tag} after the refused merge (delete it manually): ${(released.stderr || released.stdout || "").slice(0, 200)}` };
        }
        return merged;
      }
      // V1 tagging tail: GitHub confirms the merge, main is checked out and
      // fast-forwarded, then the merged main is tagged vX.Y.Z — every step
      // checked and fail-closed (the merge itself stays put on tail failure).
      // The reservation retargets the pre-merge tag onto the merge commit.
      log(`merge: squash-merged PR #${prNumber} at ${merged.mergeCommitOid.slice(0, 7)} (branch ${merged.branch}) — running the tagging tail`);
      const tailed = await mergeTail({ run, repoRoot, merged, prNumber, reservation: { tag: bump.tag, reservedAt: bump.reservedAt } });
      if (tailed.code !== 0) return tailed;
      log(`merge: ${bump.tag} tagged at the merge commit`);
      // --delete-branch equivalent, run ONLY after GitHub confirmed MERGED and
      // the release tag landed (run-3 dogfood P1: deleting earlier means a
      // failed confirmation or tail strands a merged PR whose branch is already
      // gone). Failure is disclosed as a warning — it cannot un-merge. The
      // warning/note ride a dedicated field (round-5 review P2: stuffing it
      // into stderr on a code-0 result was never shown to anyone) which the
      // loop logs after a successful merge.
      const del = await deleteMergedBranch({ run, repoRoot, branch: merged.branch, isCrossRepository: merged.isCrossRepository });
      if (!del.ok) {
        return { ...tailed, warning: del.detail };
      }
      if (del.note) log(`merge: ${del.note}`);
      else log(`merge: branch ${merged.branch} deleted`);
      return del.note ? { ...tailed, note: del.note } : tailed;
    },
    postMergeGates: async () => {
      const results = [logGate(await gateMainGreen({ run, repoRoot }))];
      return results;
    },
    dogfood: options.dogfood,
    mergeMode: options.mergeMode,
    maxIterations: options.maxIterations,
    cooldownSeconds: options.cooldownSeconds,
    log,
  });

  console.log(`\n[dev-loop] stopped=${summary.stopped} reason=${summary.reason}`);
  writeFileSync(join(artDir, "report-last.json"), `${JSON.stringify(summary, null, 2)}\n`);
  // Return (not process.exit) so main's finally removes the phase HOME first.
  return summary.stopped === "failure" ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[dev-loop] unexpected failure: ${String(error?.stack ?? error)}`);
    process.exit(1);
  });
