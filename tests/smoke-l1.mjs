// tests/smoke-l1.mjs
// L1 smoke: the dev-loop's --dry-run must pass against the current checkout and
// report context-dependent gates as SKIPPED. It passes --merge auto --dogfood on
// (safe: dry-run exits before any merge or dogfood logic) so the flag → header
// wiring is exercised end-to-end — since I3, auto without dogfood exits 2.
// No agent is invoked, nothing mutates. This is a script smoke (no Copilot SDK
// dispatch, no inference to assert), so it does not use tests/smoke-harness.mjs —
// that harness serves SDK command dispatch. Note: the gates run every other
// smoke, including smoke-i3's real lane review when a PR is open — allow time.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runCommand } from "../scripts/dev-loop/phases.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const result = await runCommand("node", ["scripts/dev-loop.mjs", "--dry-run", "--merge", "auto", "--dogfood", "on"], { cwd: repoRoot, timeoutMs: 15 * 60_000 });
console.log(result.stdout);
assert.equal(result.code, 0, `dry-run must exit 0:\n${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /DRY-RUN: .*merge=auto, dogfood=on/);
assert.match(result.stdout, /PASS status/);
assert.match(result.stdout, /SKIPPED/);
console.log("SMOKE PASS L1: dev-loop dry-run green on current checkout (merge=auto, dogfood=on surfaced)");
