import { readdirSync } from "node:fs";
import { join } from "node:path";
import { buildZcodeArgs } from "./phases.mjs";
import { parseStatusLine, roadmapIncrementState } from "./status.mjs";

const ok = (name, detail) => ({ name, ok: true, detail });
const bad = (name, detail) => ({ name, ok: false, detail });
const DRY_RUN_SMOKE = "smoke-l1.mjs";
const SHARED_HARNESS = "smoke-harness.mjs"; // shared module since I2, not a smoke scenario

function testFiles(repoRoot) {
  return readdirSync(join(repoRoot, "tests")).filter((f) => f.endsWith(".test.mjs"));
}

function smokeFiles(repoRoot, exclude = []) {
  return readdirSync(join(repoRoot, "tests")).filter(
    (f) => /^smoke-.*\.mjs$/.test(f) && f !== SHARED_HARNESS && !exclude.includes(f),
  );
}

// Full 40-hex git OID, the shape gh reports for headRefOid (same shape the I2
// capture validates; kept local so the loop never imports from extensions/).
const OID_PATTERN = /^[0-9a-f]{40}$/i;

export const isFullOid = (value) => typeof value === "string" && OID_PATTERN.test(value);

// Establishes the PR head in the checkout: check out the branch, ff-only-sync
// it to origin, and verify the result IS the assessed head. Gates and reviews
// run against this checkout, so without the equality check the head pin could
// certify a stale or locally-ahead tree while the loop merges the remote head.
export async function gateBranchHead({ run, repoRoot, headRefName, headRefOid }) {
  if (!isFullOid(headRefOid)) {
    return bad("branch-checkout", `no valid headRefOid for the open PR (${String(headRefOid ?? "missing")}); cannot establish the reviewed head`);
  }
  const checkout = await run("git", ["checkout", headRefName], { cwd: repoRoot });
  if (checkout.code !== 0) {
    return bad("branch-checkout", `git checkout ${headRefName} failed: ${checkout.stderr.slice(0, 200)}`);
  }
  const fetched = await run("git", ["fetch", "--quiet", "origin"], { cwd: repoRoot });
  const synced = fetched.code === 0
    ? await run("git", ["merge", "--ff-only", `origin/${headRefName}`], { cwd: repoRoot })
    : fetched;
  const localHead = await run("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (fetched.code !== 0 || synced.code !== 0 || localHead.code !== 0 || localHead.stdout.trim() !== headRefOid) {
    return bad("branch-checkout", `checkout is not at PR head ${headRefOid.slice(0, 7)} (at ${localHead.stdout.trim().slice(0, 7) || "?"}): ${(synced.stderr || fetched.stderr || localHead.stderr || "").slice(0, 200)}`);
  }
  return ok("branch-checkout", `checkout at PR head ${headRefOid.slice(0, 7)} (${headRefName})`);
}

export async function gateRepoIdle({ run, repoRoot }) {
  const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
  if (branch.code !== 0 || branch.stdout.trim() !== "main") {
    return bad("repo-idle", `expected checkout on main, found "${branch.stdout.trim()}"`);
  }
  const status = await run("git", ["status", "--porcelain"], { cwd: repoRoot });
  if (status.code !== 0) return bad("repo-idle", `git status failed: ${status.stderr.slice(0, 200)}`);
  if (status.stdout.trim()) return bad("repo-idle", `working tree not clean: ${status.stdout.trim().slice(0, 200)}`);
  const fetched = await run("git", ["fetch", "--quiet", "origin"], { cwd: repoRoot });
  if (fetched.code !== 0) return bad("repo-idle", `git fetch failed: ${fetched.stderr.slice(0, 200)}`);
  const refs = await run("git", ["rev-parse", "main", "origin/main"], { cwd: repoRoot });
  const [local, remote] = refs.stdout.trim().split("\n");
  if (refs.code !== 0 || local !== remote) return bad("repo-idle", `main ${local?.slice(0, 7)} != origin/main ${remote?.slice(0, 7)}`);
  const prs = await run("gh", ["pr", "list", "--state", "open", "--json", "number,headRefName"], { cwd: repoRoot });
  let open = [];
  try { open = JSON.parse(prs.stdout || "[]"); } catch { return bad("repo-idle", `gh pr list output unparseable: ${prs.stdout.slice(0, 200)}`); }
  if (prs.code !== 0 || open.length) return bad("repo-idle", `open PRs: ${open.map((p) => `#${p.number} (${p.headRefName})`).join(", ") || prs.stderr.slice(0, 200)}`);
  return ok("repo-idle", "main clean, synced, no open PRs");
}

// Proves the exact headless worker invocation runs BEFORE dispatching a real
// phase: one cheap probe turn catches CLI flag drift (0.16.5 rejected
// --max-turns while still listing it in --help) and missing model config/auth
// ("zcode login", ~/.zcode/cli/config.json) without burning a worker run.
// Pass the isolated phase env (buildPhaseEnv) so the probe exercises the exact
// environment phases run under — including its copied model config.
export async function gateZcodeHeadless({ run, zcode, repoRoot, buildArgs = buildZcodeArgs, env }) {
  const args = buildArgs({ prompt: "Reply with the single word: ok", repoRoot });
  const result = await run(zcode, args, { cwd: repoRoot, timeoutMs: 3 * 60_000, env });
  if (result.code === 0 && !result.timedOut) {
    return ok("zcode-headless", "probe turn completed with the worker arg set");
  }
  const firstLine = (result.stderr || result.stdout).split("\n").find((l) => l.trim()) ?? "";
  return bad("zcode-headless", `probe failed (code=${result.code}, timedOut=${result.timedOut}): ${firstLine.slice(0, 200)} — check CLI flags, model config (~/.zcode/cli/config.json), and zcode login`);
}

export async function gateTests({ run, repoRoot }) {
  const files = testFiles(repoRoot);
  if (!files.length) return bad("tests", "no tests/*.test.mjs discovered");
  const result = await run("node", ["--test", ...files.map((f) => join("tests", f))], { cwd: repoRoot, timeoutMs: 10 * 60_000 });
  if (result.code !== 0) return bad("tests", result.stdout.split("\n").slice(-6).join(" ").slice(0, 300));
  return ok("tests", `${files.length} test file(s) green`);
}

export async function gateSmokes({ run, repoRoot, exclude = [] }) {
  const files = smokeFiles(repoRoot, exclude);
  for (const file of files) {
    const result = await run("node", [join("tests", file)], { cwd: repoRoot, timeoutMs: 5 * 60_000 });
    if (result.code !== 0) return bad("smokes", `${file} failed: ${result.stdout.split("\n").slice(-4).join(" ").slice(0, 300)}`);
  }
  return ok("smokes", files.length ? `${files.length} smoke script(s) green${exclude.length ? ` (excluded: ${exclude.join(", ")})` : ""}` : "no smoke scripts discovered");
}

export async function gateIncrementPr({ run, repoRoot }) {
  const prs = await run("gh", ["pr", "list", "--state", "open", "--json", "number,headRefName,url,headRefOid"], { cwd: repoRoot });
  let open = [];
  try { open = JSON.parse(prs.stdout || "[]"); } catch { /* handled below */ }
  if (prs.code !== 0 || open.length !== 1) {
    return bad("increment-pr", `expected exactly one open PR, found ${open.length}${prs.code !== 0 ? ` (gh exit ${prs.code})` : ""}`);
  }
  const [pr] = open;
  return { name: "increment-pr", ok: true, detail: `PR #${pr.number} (${pr.headRefName})`, prNumber: pr.number, headRefName: pr.headRefName, headRefOid: pr.headRefOid };
}

// Mergeability is checked at assessment time, not discovered at merge time: a
// branch that drifted behind main (the I4 landing hit exactly this — the loop
// burned a full review cycle and failed only at `gh pr merge`) must fail the
// cheap gate instead. UNKNOWN passes: GitHub computes this asynchronously, and
// the pre-merge head pin still catches the rare late conflict fail-closed.
export function mergeabilityGate(pr) {
  if (pr?.mergeable === "CONFLICTING") {
    return bad("mergeable", `PR #${pr.number} is CONFLICTING — merge main into ${pr.headRefName}, resolve, and push before re-assessment`);
  }
  return ok("mergeable", `PR #${pr.number} mergeable: ${pr?.mergeable ?? "unknown"}`);
}

export async function gateDocsUpdated({ readFileSync, repoRoot, increment }) {
  const roadmap = readFileSync(join(repoRoot, "ROADMAP.md"), "utf8");
  if (roadmapIncrementState(roadmap, increment) !== "done") {
    return bad("docs-updated", `ROADMAP row for ${increment} is not ✅`);
  }
  const handoff = readFileSync(join(repoRoot, "HANDOFF.md"), "utf8");
  const status = parseStatusLine(handoff);
  // `done` after a ✅ row is the legitimate final-increment state (the worker
  // prompt instructs it); anything else must name the next pending increment.
  if (status.kind === "done") {
    return { name: "docs-updated", ok: true, detail: "ROADMAP ✅ + STATUS done (final increment)", nextIncrement: null };
  }
  if (status.kind !== "next") return bad("docs-updated", `HANDOFF STATUS is ${status.kind}`);
  if (status.increment === increment) return bad("docs-updated", `HANDOFF STATUS still targets ${increment}`);
  if (roadmapIncrementState(roadmap, status.increment) !== "pending") {
    return bad("docs-updated", `HANDOFF STATUS targets ${status.increment}, which is not a pending increment`);
  }
  return { name: "docs-updated", ok: true, detail: `ROADMAP ✅ + STATUS next=${status.increment}`, nextIncrement: status.increment };
}

export async function gateMainGreen({ run, repoRoot }) {
  const tests = await gateTests({ run, repoRoot });
  if (!tests.ok) return { ...tests, name: "main-green" };
  const smokes = await gateSmokes({ run, repoRoot, exclude: [DRY_RUN_SMOKE] });
  if (!smokes.ok) return { ...smokes, name: "main-green" };
  return ok("main-green", `tests + smokes green on merged main (excluded ${DRY_RUN_SMOKE})`);
}

export function reportGates(results) {
  return results.map((g) => `${g.ok ? "PASS" : "FAIL"} ${g.name} — ${g.detail}`).join("\n");
}
