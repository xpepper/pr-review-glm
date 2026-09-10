// tests/smoke-l1.mjs
// L1 smoke: the dev-loop's --dry-run must pass against the current checkout and
// report context-dependent gates as SKIPPED. No agent is invoked, nothing mutates.
// This is a script smoke (no Copilot SDK dispatch, no inference to assert), so it
// does not use tests/smoke-harness.mjs — that harness serves SDK command dispatch.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runCommand } from "../scripts/dev-loop/phases.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const result = await runCommand("node", ["scripts/dev-loop.mjs", "--dry-run"], { cwd: repoRoot, timeoutMs: 15 * 60_000 });
console.log(result.stdout);
assert.equal(result.code, 0, `dry-run must exit 0:\n${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /DRY-RUN/);
assert.match(result.stdout, /PASS status/);
assert.match(result.stdout, /SKIPPED/);
console.log("SMOKE PASS L1: dev-loop dry-run green on current checkout");
