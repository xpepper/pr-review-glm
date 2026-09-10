// tests/dev-loop-dogfood.test.mjs — I3 dogfood wiring: the plugin's machine
// summary maps into the loop's review contract fail-closed, and the CLI
// enforces --merge auto => --dogfood on before anything is dispatched.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dogfoodVerdict, parseMachineSummary } from "../scripts/dev-loop/dogfood.mjs";
import { runCommand } from "../scripts/dev-loop/phases.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("parseMachineSummary", () => {
  it("extracts and parses the fenced machine block from report messages", () => {
    const messages = ["Reviewed PR #7 — \"I3\"", "Findings: 1", "```z-pr-review-findings\n{\"status\":\"complete\",\"findings\":[{\"severity\":\"P1\",\"title\":\"x\"}],\"dropped\":0}\n```"];
    const summary = parseMachineSummary(messages);
    assert.equal(summary.status, "complete");
    assert.equal(summary.findings[0].severity, "P1");
  });
  it("returns null with no block and a marker object for malformed JSON", () => {
    assert.equal(parseMachineSummary(["no block here"]), null);
    assert.equal(parseMachineSummary(["```z-pr-review-findings\n{not json}\n```"]).status, "malformed-json");
  });
});

describe("dogfoodVerdict (fail-closed mapping; verdict is code-owned, never model text)", () => {
  it("blocks on an incomplete or missing summary", () => {
    for (const summary of [null, { status: "failed", reason: "deadline exceeded after 1ms" }, { status: "malformed-json" }, []]) {
      const verdict = dogfoodVerdict(summary);
      assert.equal(verdict.verdict, "request-changes");
      assert.equal(verdict.findings[0].severity, "P1");
    }
  });
  it("request-changes on P0/P1, approve-with-nits on P2-or-lower, approve on none", () => {
    assert.equal(dogfoodVerdict({ status: "complete", findings: [{ severity: "P0", title: "a" }] }).verdict, "request-changes");
    assert.equal(dogfoodVerdict({ status: "complete", findings: [{ severity: "P1", title: "a" }] }).verdict, "request-changes");
    const nits = dogfoodVerdict({ status: "complete", findings: [{ severity: "P2", title: "a" }, { severity: "nit", title: "b" }] });
    assert.equal(nits.verdict, "approve-with-nits");
    assert.deepEqual(nits.findings.map((f) => f.severity), ["P2", "P2"], "P3/nit map to P2 in the loop contract");
    assert.deepEqual(dogfoodVerdict({ status: "complete", findings: [] }), { verdict: "approve", findings: [] });
  });
  it("drops malformed findings rather than inventing severity for them", () => {
    const verdict = dogfoodVerdict({ status: "complete", findings: [{ severity: "P1" }, "junk", { severity: "P2", title: "ok" }] });
    assert.deepEqual(verdict.findings, [{ severity: "P2", title: "ok" }]);
  });
});

describe("dev-loop CLI auto⇒dogfood (I3)", () => {
  it("--merge auto without --dogfood on exits 2 before dispatching", async () => {
    const result = await runCommand("node", ["scripts/dev-loop.mjs", "--merge", "auto"], { cwd: repoRoot, timeoutMs: 30_000 });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--merge auto requires --dogfood on/);
  });
  it("--dry-run --merge auto --dogfood on passes validation and reaches the gates", async () => {
    const result = await runCommand("node", ["scripts/dev-loop.mjs", "--dry-run", "--merge", "auto", "--dogfood", "on"], { cwd: repoRoot, timeoutMs: 10 * 60_000 });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /dogfood=on/);
  });
});
