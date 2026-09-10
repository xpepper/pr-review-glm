import { readdirSync } from "node:fs";
import { join } from "node:path";
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

export async function gatePrototypeAbsent({ run }) {
  const list = await run("copilot", ["plugins", "list"]);
  if (list.code !== 0) return bad("prototype-absent", `copilot plugins list failed: ${list.stderr.slice(0, 200)}`);
  if (list.stdout.includes("copilot-pr-review")) {
    return bad("prototype-absent", "copilot-pr-review registered again; run: copilot plugin uninstall copilot-pr-review");
  }
  return ok("prototype-absent", "prior prototype not registered");
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
  const prs = await run("gh", ["pr", "list", "--state", "open", "--json", "number,headRefName,url"], { cwd: repoRoot });
  let open = [];
  try { open = JSON.parse(prs.stdout || "[]"); } catch { /* handled below */ }
  if (prs.code !== 0 || open.length !== 1) {
    return bad("increment-pr", `expected exactly one open PR, found ${open.length}${prs.code !== 0 ? ` (gh exit ${prs.code})` : ""}`);
  }
  const [pr] = open;
  return { name: "increment-pr", ok: true, detail: `PR #${pr.number} (${pr.headRefName})`, prNumber: pr.number, headRefName: pr.headRefName };
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
