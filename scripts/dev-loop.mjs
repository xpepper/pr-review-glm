#!/usr/bin/env node
// dev-loop: script-orchestrated increment loop (spec:
// docs/superpowers/specs/2026-09-10-dev-loop-design.md).
// The loop owns sequencing, gates, and merging; every judgment phase is a fresh
// headless zcode invocation; nothing an agent claims is trusted without a gate.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseStatusLine, roadmapIncrementState } from "./dev-loop/status.mjs";
import { PHASE_LIMITS, buildZcodeArgs, renderPrompt, resolveZcodeCli, runCommand } from "./dev-loop/phases.mjs";
import {
  gateBranchHead, gateDocsUpdated, gateMainGreen, gateRepoIdle,
  gateSmokes, gateTests, gateZcodeHeadless, isFullOid, mergeabilityGate, reportGates,
} from "./dev-loop/gates.mjs";
import { runLoop } from "./dev-loop/loop.mjs";
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

function phaseRunner({ zcode, template, vars, limits }) {
  const prompt = renderPrompt(template, vars);
  const args = buildZcodeArgs({ prompt, repoRoot });
  return async () => {
    const result = await runCommand(zcode, args, { cwd: repoRoot, timeoutMs: limits.timeoutMs });
    if (result.code !== 0 || result.timedOut) console.error(result.stdout.slice(-2000), result.stderr.slice(-2000));
    return result;
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.dryRun) return dryRun(options);
  const zcode = resolveZcodeCli();
  mkdirSync(artDir, { recursive: true });
  const run = (command, args, opts) => runCommand(command, args, opts);
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
      await gateRepoIdle({ run, repoRoot }),
      await gateZcodeHeadless({ run, zcode, repoRoot }),
      await gateTests({ run, repoRoot }),
      await gateSmokes({ run, repoRoot, exclude: ["smoke-l1.mjs"] }),
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
        zcode, template: loadTemplate("worker-prompt.md"),
        vars: { INCREMENT: status.increment }, limits: PHASE_LIMITS.worker,
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
        const mergeable = mergeabilityGate(open[0]);
        if (!mergeable.ok) return { results: [mergeable], prNumber, headRefOid };
        results.push(mergeable);
        // The worker may leave the checkout anywhere; gates and the reviewer must
        // see the exact PR head, so establish it before anything runs (zero-trust:
        // never assume the worker left it there or that it matches the remote
        // head the pin records).
        const branchHead = await gateBranchHead({ run, repoRoot, headRefName: open[0].headRefName, headRefOid });
        if (!branchHead.ok) return { results: [branchHead], prNumber, headRefOid };
        results.push(branchHead);
        results.push(await gateTests({ run, repoRoot }));
        results.push(await gateSmokes({ run, repoRoot, exclude: ["smoke-l1.mjs"] }));
        results.push(await gateDocsUpdated({ readFileSync, repoRoot, increment: workedIncrement }));
      } else {
        results.push({ name: "increment-pr", ok: false, detail: `expected exactly one open PR, found ${open.length}` });
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
          zcode, template: loadTemplate("reviewer-prompt.md"),
          vars: { PR_NUMBER: prNumber, REPO_ROOT: repoRoot, HEAD_REF: headRefName, REVIEW_FILE: reviewFile },
          limits: PHASE_LIMITS.reviewer,
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
    runDogfood: (prNumber) => runDogfoodReview({
      prNumber, repoRoot, timeoutMs: PHASE_LIMITS.dogfood.timeoutMs, log: (line) => console.log(`[dev-loop] ${line}`),
    }),
    runFixer: async (prNumber, findings) => {
      try {
        const pr = await run("gh", ["pr", "view", String(prNumber), "--json", "headRefName"], { cwd: repoRoot });
        const headRefName = JSON.parse(pr.stdout || "{}").headRefName ?? "";
        const checkout = await run("git", ["checkout", headRefName], { cwd: repoRoot });
        if (checkout.code !== 0) {
          return { code: checkout.code, stdout: checkout.stdout, stderr: checkout.stderr, timedOut: false };
        }
        return phaseRunner({
          zcode, template: loadTemplate("fixer-prompt.md"),
          vars: { PR_NUMBER: prNumber, REPO_ROOT: repoRoot, HEAD_REF: headRefName, FINDINGS_JSON: JSON.stringify(findings) },
          limits: PHASE_LIMITS.fixer,
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
    merge: async (prNumber) => {
      const merged = await run("gh", ["pr", "merge", String(prNumber), "--squash", "--delete-branch"], { cwd: repoRoot });
      if (merged.code === 0) {
        await run("git", ["checkout", "main"], { cwd: repoRoot });
        await run("git", ["pull", "--ff-only"], { cwd: repoRoot });
      }
      return merged;
    },
    postMergeGates: async () => {
      const results = [await gateMainGreen({ run, repoRoot })];
      return results;
    },
    dogfood: options.dogfood,
    mergeMode: options.mergeMode,
    maxIterations: options.maxIterations,
    cooldownSeconds: options.cooldownSeconds,
    log: (line) => console.log(`[dev-loop] ${line}`),
  });

  console.log(`\n[dev-loop] stopped=${summary.stopped} reason=${summary.reason}`);
  writeFileSync(join(artDir, "report-last.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.exit(summary.stopped === "failure" ? 1 : 0);
}

main().catch((error) => {
  console.error(`[dev-loop] unexpected failure: ${String(error?.stack ?? error)}`);
  process.exit(1);
});
