// STATUS: protocol per the dev-loop spec: the first line matching ^STATUS: .
// Increment ids cover every ROADMAP series: I/L (plugin and loop work), V
// (plugin release versioning, from V1), and C (custom roles, from C1).
export function parseStatusLine(text) {
  const match = text.match(/^STATUS: (.+)$/m);
  if (!match) return { kind: "missing" };
  const value = match[1].trim();
  const next = /^next=([ILVC]\d+)$/i.exec(value);
  if (next) return { kind: "next", increment: next[1].toUpperCase() };
  if (/^done$/i.test(value)) return { kind: "done" };
  const blocked = /^blocked:\s*(.+)$/i.exec(value);
  if (blocked) return { kind: "blocked", reason: blocked[1].trim() };
  return { kind: "invalid", line: match[1] };
}

export function roadmapIncrementState(roadmapText, increment) {
  const row = new RegExp(`^\\| ${increment} \\|([^|]*)\\|`, "m").exec(roadmapText);
  if (!row) return "unknown";
  return row[1].includes("✅") ? "done" : "pending";
}
