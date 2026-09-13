import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { buildZcodeArgs, persistPhaseOutput } from "./phases.mjs";
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
// The probe must EXERCISE a tool, not just complete a text turn: on 2026-09-12
// both the I5 worker and the independent reviewer phases ran with NO shell tool
// (file tools worked; both sessions honestly said so in output nobody kept),
// and a "Reply with the single word: ok" probe sails through that condition —
// a degraded toolset then costs a full worker cycle. The expected value is an
// opaque token generated at probe time and carried ONLY in the child
// environment (never in the prompt or argv, which a model can read): the
// session can produce it in its reply solely by executing something in that
// environment (`echo $ZPR_PROBE_TOKEN` through the shell). Reviewer hardening
// (PR #32): the first version asserted a computed marker (`zpr-probe-42` from
// `$((6*7))`), which a shell-less session could still calculate in prose.
// Residual, accepted: the probe proves a code-execution path that can observe
// the child env exists — not specifically the shell tool — but that is the
// operationally relevant property for phases (a session that cannot execute
// anything cannot run tests, git, or gh).
const PROBE_ENV_VAR = "ZPR_PROBE_TOKEN";
// 2026-09-13: six launches stopped on a single probe attempt. In the
// degraded-toolset regime a goal-phrased probe session routes through a
// shell-capable subagent — but that attempt itself is transport-flaky (the
// AI SDK cacheControl-breakpoint warning signature: an attempt that dies
// wordlessly). The gate retries on code-owned terms: a fresh token per
// attempt, pass on the first demonstrated execution, fail-closed only when
// every attempt failed.
const PROBE_ATTEMPTS = 3;
export async function gateZcodeHeadless({
  run, zcode, repoRoot, buildArgs = buildZcodeArgs, env,
  artDir = join(repoRoot, ".dev-loop"), persist = persistPhaseOutput, log = () => {},
}) {
  let last = null;
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
    const token = `zpr-probe-${randomBytes(16).toString("hex")}`;
    // Prompt phrasing is load-bearing (2026-09-13 controlled diagnostic): the
    // old wording ("… using your shell tool …") ANCHORED top-level sessions —
    // shell-less since 2026-09-12, though they hold agent-delegation tools —
    // on the one tool they lack, so they refused instead of delegating (failed
    // identically under the isolated phase env and the operator's normal env).
    // This goal-phrased variant ("use a shell", the mechanism left to the
    // session) passes under the exact isolated phase env: the session routes
    // the command through a shell-capable subagent — the same recovery path
    // phase workers use. The claim proven is unchanged: only executing
    // something in the child env can produce the env-only token.
    const args = buildArgs({
      prompt: `Use a shell to run: echo $${PROBE_ENV_VAR} — show me the exact output`,
      repoRoot,
    });
    const result = await run(zcode, args, {
      cwd: repoRoot,
      timeoutMs: 3 * 60_000,
      env: { ...(env ?? process.env), [PROBE_ENV_VAR]: token },
    });
    // Every attempt's full transcript survives via the #32 phase machinery —
    // the 2026-09-13 stops surfaced only a first line of SDK noise while the
    // session's actual behavior stayed unknowable. Persistence is never fatal.
    const persisted = persist({ artDir, name: "probe", index: attempt, result });
    if (persisted.error) log(`[dev-loop] warning: ${persisted.error}`);
    else log(`[dev-loop] probe transcript: ${persisted.file}`);
    if (result.code === 0 && !result.timedOut && String(result.stdout ?? "").includes(token)) {
      return ok("zcode-headless", `probe turn completed with the worker arg set (execution in the child env exercised, attempt ${attempt}/${PROBE_ATTEMPTS})`);
    }
    last = result;
  }
  // The session's own words (stdout) outrank stderr: an AI SDK warning line on
  // stderr masked the session's actual refusal in two 2026-09-13 stops, and
  // the quoted reply is the diagnostic the detail exists for. CLI-level
  // failures (flags/config/auth, nonzero exit) usually have empty stdout, so
  // their stderr first line still surfaces.
  const firstLine = (String(last.stdout ?? "").trim() ? last.stdout : last.stderr || "")
    .split("\n").find((l) => l.trim()) ?? "";
  return bad("zcode-headless", `probe failed after ${PROBE_ATTEMPTS} attempts (last: code=${last.code}, timedOut=${last.timedOut}): ${firstLine.slice(0, 200)} — attempt transcripts under ${artDir} — check CLI flags, model config (~/.zcode/cli/config.json), zcode login, and the phase TOOLSET: phases need to execute commands (2026-09-12: worker and reviewer ran shell-less while text-only probes kept passing)`);
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

// Preflight sequence with probe fail-fast: repo-idle and the toolset probe
// run first (both cheap); a FAILED probe skips tests and smokes — they cannot
// diagnose a phase environment that cannot execute commands, and running them
// only spends ~a minute before the identical stop (2026-09-13 launch 1 wasted
// exactly that after the probe had already refused; flagged then, folded
// here). Every other gate failure keeps the historical run-all behavior.
export async function runPreflightGates({ run, repoRoot, zcode, env, log = () => {} }) {
  const logGate = (gate) => { log(`gate ${gate.name}: ${gate.ok ? "PASS" : "FAIL"} — ${gate.detail}`); return gate; };
  const results = [logGate(await gateRepoIdle({ run, repoRoot }))];
  const probe = logGate(await gateZcodeHeadless({ run, zcode, repoRoot, env }));
  results.push(probe);
  if (!probe.ok) return results;
  results.push(logGate(await gateTests({ run, repoRoot })));
  results.push(logGate(await gateSmokes({ run, repoRoot, exclude: ["smoke-l1.mjs"] })));
  return results;
}

// The assessment requirement is the spec's "exactly one open PR for the
// increment branch", not exactly one open PR repo-wide: legitimate stacked
// loop-side fix PRs exist (2026-09-13: #38 fix-loop-smoke-retry stacked on #37
// i7-gated-comment-publication made the global count 2 and stranded the
// iteration). Selection is by the increment's documented branch prefix
// (`i<N>-`, AGENTS.md) — the same signature resume trusts — and other open PRs
// are disclosed, never silently ignored.
export function selectIncrementPr(open, increment) {
  const label = String(increment ?? "");
  const prefix = `${label.toLowerCase()}-`;
  const matches = open.filter((p) => typeof p?.headRefName === "string" && p.headRefName.toLowerCase().startsWith(prefix));
  const others = open.filter((p) => !matches.includes(p));
  if (matches.length !== 1) {
    const otherNote = others.length ? `; ${others.length} other open PR(s) present: ${others.map((p) => `#${p.number} (${p.headRefName})`).join(", ")}` : "";
    return { ok: false, detail: `expected exactly one open PR for ${label || "the increment"} (branch ${prefix}<slug>), found ${matches.length}${otherNote}` };
  }
  return { ok: true, pr: matches[0], others };
}

export async function gateIncrementPr({ run, repoRoot, increment }) {
  const prs = await run("gh", ["pr", "list", "--state", "open", "--json", "number,headRefName,url,headRefOid,author"], { cwd: repoRoot });
  let open = [];
  try { open = JSON.parse(prs.stdout || "[]"); } catch { /* handled below */ }
  if (prs.code !== 0) {
    return bad("increment-pr", `gh pr list failed (exit ${prs.code})`);
  }
  const selected = selectIncrementPr(open, increment);
  if (!selected.ok) return bad("increment-pr", selected.detail);
  const { pr, others } = selected;
  const owned = await verifyIncrementPrOwnedByViewer({ run, repoRoot, pr });
  if (!owned.ok) return bad("increment-pr", owned.detail);
  const detail = `PR #${pr.number} (${pr.headRefName})${others.length ? ` — ${others.length} other open PR(s) ignored: ${others.map((p) => `#${p.number} (${p.headRefName})`).join(", ")}` : ""}`;
  return { name: "increment-pr", ok: true, detail, prNumber: pr.number, headRefName: pr.headRefName, headRefOid: pr.headRefOid };
}

// The selected increment PR feeds the head pin and the loop's auto-merge:
// a branch NAME is not provenance. Any push-access account (or a fork
// contributor naming their branch i<N>-…) could otherwise ride the loop's
// merge authority past the repo's human-review protection. The loop assesses
// and merges only the authenticated viewer's own PRs — the same
// viewer-ownership posture as the plugin's publish marker scan.
export async function verifyIncrementPrOwnedByViewer({ run, repoRoot, pr }) {
  const who = await run("gh", ["api", "user", "--jq", ".login"], { cwd: repoRoot });
  const viewer = who.code === 0 ? String(who.stdout ?? "").trim() : "";
  if (!viewer) {
    const firstLine = String(who.stderr ?? "").split("\n").find((l) => l.trim()) ?? "";
    return { ok: false, detail: `could not establish the authenticated viewer (gh api user exit ${who.code}): ${firstLine || "no output"}` };
  }
  const author = pr?.author?.login;
  if (author !== viewer) {
    return { ok: false, detail: `PR #${pr?.number} (${pr?.headRefName ?? "?"}) was opened by ${author ?? "an unknown author"}, not the authenticated viewer ${viewer} — the loop assesses and merges only its own increment PRs` };
  }
  return { ok: true, detail: `viewer ${viewer} owns PR #${pr?.number}` };
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
