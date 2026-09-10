// tests/dev-loop-status.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStatusLine, roadmapIncrementState } from "../scripts/dev-loop/status.mjs";

const handoff = (status) => `# HANDOFF.md — instructions for the next session\n\n${status}\n\nProse may mention STATUS: done later, but only the first line counts.\n`;

describe("parseStatusLine", () => {
  it("parses next with uppercase normalization", () => {
    assert.deepEqual(parseStatusLine(handoff("STATUS: next=i3")), { kind: "next", increment: "I3" });
    assert.deepEqual(parseStatusLine(handoff("STATUS: next=L1")), { kind: "next", increment: "L1" });
  });
  it("parses blocked with a reason", () => {
    assert.deepEqual(parseStatusLine(handoff("STATUS: blocked: gh auth expired")), {
      kind: "blocked", reason: "gh auth expired",
    });
  });
  it("parses done", () => {
    assert.deepEqual(parseStatusLine(handoff("STATUS: done")), { kind: "done" });
  });
  it("reports missing when no line exists", () => {
    assert.deepEqual(parseStatusLine("# HANDOFF\n\nNo status yet.\n"), { kind: "missing" });
  });
  it("reports invalid values with the offending line", () => {
    const result = parseStatusLine(handoff("STATUS: next=whatever"));
    assert.equal(result.kind, "invalid");
    assert.equal(result.line, "next=whatever");
  });
  it("uses the first STATUS line even if prose repeats the marker", () => {
    assert.equal(parseStatusLine("STATUS: blocked: first\n\nSTATUS: done\n").kind, "blocked");
  });
});

describe("roadmapIncrementState", () => {
  const roadmap = `| ID | Status | Outcome | Depends on |\n|----|--------|---------|------------|\n| I2 | ✅ Done (PR #5) | Capture. | I1 |\n| L1 | ⬜ Pending | dev-loop. | I2 |\n| I3 | ⬜ Pending | First review. | I2, L1 |\n`;
  it("distinguishes done, pending, unknown", () => {
    assert.equal(roadmapIncrementState(roadmap, "I2"), "done");
    assert.equal(roadmapIncrementState(roadmap, "I3"), "pending");
    assert.equal(roadmapIncrementState(roadmap, "I9"), "unknown");
  });
});
