#!/usr/bin/env node
// dev-loop: script-orchestrated increment loop (spec:
// docs/superpowers/specs/2026-09-10-dev-loop-design.md).
// The loop owns sequencing, gates, and merging; every judgment phase is a fresh
// headless zcode invocation; nothing an agent claims is trusted without a gate.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseStatusLine, roadmapIncrementState } from "./dev-loop/status.mjs";
import { PHASE_LIMITS, buildZcodeArgs, renderPrompt, resolveZcodeCli, runCommand } from "./dev-loop/phases.mjs";
import {
  gateDocsUpdated, gateMainGreen, gatePrototypeAbsent, gateRepoIdle,
  gateSmokes, gateTests, reportGates,
} from "./dev-loop/gates.mjs";
import { runLoop } from "./dev-loop/loop.mjs";

const repoRoot = process.cwd();
const artDir = join(repoRoot, ".dev-loop");

function parseArgs(argv) {
  const options = { maxIterations: 1, cooldownSeconds: 60, dryRun: false, dogfood: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--max-iterations") options.maxIterations = Number(argv[++i]);
    else if (arg === "--cooldown-seconds") options.cooldownSeconds = Number(argv[++i]);
    else if (arg === "--dogfood") options.dogfood = argv[++i] === "on";
    else if (arg === "--help") { printUsage(); process.exit(0); }
    else { console.error(`unknown argument: ${arg}`); printUsage(); process.exit(2); }
  }
  if (!(options.maxIterations >= 1) || !(options.cooldownSeconds >= 0)) {
    console.error("--max-iterations and --cooldown-seconds must be non-negative integers");
    process.exit(2);
  }
  return options;
}
function printUsage() {
  console.log("usage: node scripts/dev-loop.mjs [--max-iterations N] [--cooldown-seconds S] [--dry-run] [--dogfood on|off]");
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

async function dryRun() {
  console.log("DRY-RUN: gates only, no agent phases, nothing mutates.");
  const results = [];
  const status = statusGate();
  results.push(status);
  const run = (command, args, opts) => runCommand(command, args, opts);
  results.push(await gatePrototypeAbsent({ run }));
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
  const args = buildZcodeArgs({ prompt, repoRoot, maxTurns: limits.maxTurns });
  return async () => {
    const result = await runCommand(zcode, args, { cwd: repoRoot, timeoutMs: limits.timeoutMs });
    if (result.code !== 0 || result.timedOut) console.error(result.stdout.slice(-2000), result.stderr.slice(-2000));
    return result;
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.dryRun) return dryRun();
  if (options.dogfood) {
    console.error("--dogfood on requires the plugin's own review (lands with I3); refusing to run without it.");
    process.exit(2);
  }
  const zcode = resolveZcodeCli();
  mkdirSync(artDir, { recursive: true });
  const run = (command, args, opts) => runCommand(command, args, opts);
  // The increment under work is captured from the pre-worker STATUS: after the
  // worker rewrites HANDOFF, its STATUS names the NEXT increment, which is not
  // what gateDocsUpdated must validate.
  let workedIncrement = null;

  const summary = await runLoop({
    readStatus: async () => parseStatusLine(read("HANDOFF.md")),
    preflight: async () => [
      await gateRepoIdle({ run, repoRoot }),
      await gatePrototypeAbsent({ run }),
      await gateTests({ run, repoRoot }),
      await gateSmokes({ run, repoRoot, exclude: ["smoke-l1.mjs"] }),
    ],
    runWorker: (status) => {
      workedIncrement = status.increment;
      return phaseRunner({
        zcode, template: loadTemplate("worker-prompt.md"),
        vars: { INCREMENT: status.increment }, limits: PHASE_LIMITS.worker,
      })();
    },
    workerGates: async () => {
      const prs = await run("gh", ["pr", "list", "--state", "open", "--json", "number,headRefName,url"], { cwd: repoRoot });
      let open = [];
      try { open = JSON.parse(prs.stdout || "[]"); } catch { /* gate below reports */ }
      const results = [];
      let prNumber = null;
      if (prs.code === 0 && open.length === 1) {
        prNumber = open[0].number;
        results.push(await gateTests({ run, repoRoot }));
        results.push(await gateSmokes({ run, repoRoot, exclude: ["smoke-l1.mjs"] }));
        results.push(await gateDocsUpdated({ readFileSync, repoRoot, increment: workedIncrement }));
      } else {
        results.push({ name: "increment-pr", ok: false, detail: `expected exactly one open PR, found ${open.length}` });
      }
      return { results, prNumber };
    },
    runReviewer: async (prNumber) => {
      const pr = await run("gh", ["pr", "view", String(prNumber), "--json", "headRefName"], { cwd: repoRoot });
      const headRefName = JSON.parse(pr.stdout || "{}").headRefName ?? "";
      const reviewFile = join(artDir, "review-independent.json");
      const invocation = await phaseRunner({
        zcode, template: loadTemplate("reviewer-prompt.md"),
        vars: { PR_NUMBER: prNumber, REPO_ROOT: repoRoot, HEAD_REF: headRefName, REVIEW_FILE: reviewFile },
        limits: PHASE_LIMITS.reviewer,
      })();
      let review = null;
      try { review = JSON.parse(readFileSync(reviewFile, "utf8")); } catch { /* reviewBlocking treats null as fatal */ }
      return { ...invocation, review };
    },
    runDogfood: undefined, // harness lands with I3; --dogfood refuses to run until then
    runFixer: async (prNumber, findings) => {
      const pr = await run("gh", ["pr", "view", String(prNumber), "--json", "headRefName"], { cwd: repoRoot });
      const headRefName = JSON.parse(pr.stdout || "{}").headRefName ?? "";
      await run("git", ["checkout", headRefName], { cwd: repoRoot });
      return phaseRunner({
        zcode, template: loadTemplate("fixer-prompt.md"),
        vars: { PR_NUMBER: prNumber, REPO_ROOT: repoRoot, HEAD_REF: headRefName, FINDINGS_JSON: JSON.stringify(findings) },
        limits: PHASE_LIMITS.fixer,
      })();
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
