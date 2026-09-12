// I4: mode topologies — the fixed, code-owned lane sets for each review mode
// (spec "Review pipeline" table). Lane ids and objectives follow upstream
// pi-pr-review's documented topologies (verified against its review prompt,
// 2026-09-11): quick = 3 heavy, balanced = 5 (4 heavy + 1 light overview),
// full = balanced + 1 medium conventions/maintainability, deep = 1 integrated
// heavy. This module is original code recording those facts — no upstream
// source is copied (docs/ATTRIBUTION.md).

export const LANE_TOPOLOGIES = Object.freeze({
  quick: Object.freeze([
    Object.freeze({
      id: "correctness",
      tier: "heavy",
      objective:
        "state-transition, ordering, async-lifecycle, concurrency, cancellation, and race defects",
    }),
    Object.freeze({
      id: "correctness-contracts",
      tier: "heavy",
      objective:
        "compile, type, API/data/error-contract, boundary, integration, and wrong-transformation defects",
    }),
    Object.freeze({
      id: "security-performance",
      tier: "heavy",
      objective:
        "security vulnerabilities, plus in this quick mode all performance, resource, cleanup, scalability, I/O, memory, and contention concerns",
    }),
  ]),
  balanced: Object.freeze([
    Object.freeze({
      id: "overview",
      tier: "light",
      objective:
        "whole-PR overview: strengths, high-level risks, and at most three direct-diff P3/nit hygiene candidates",
    }),
    Object.freeze({
      id: "correctness",
      tier: "heavy",
      objective:
        "state-transition, ordering, async-lifecycle, concurrency, cancellation, and race defects",
    }),
    Object.freeze({
      id: "correctness-contracts",
      tier: "heavy",
      objective:
        "compile, type, API/data/error-contract, boundary, integration, and wrong-transformation defects",
    }),
    Object.freeze({
      id: "security-performance",
      tier: "heavy",
      objective: "security vulnerabilities",
    }),
    Object.freeze({
      id: "performance-resources",
      tier: "heavy",
      objective:
        "performance, resource cleanup/ownership, scalability, I/O, memory, and contention defects",
    }),
  ]),
  full: Object.freeze([
    Object.freeze({
      id: "overview",
      tier: "light",
      objective:
        "whole-PR overview: strengths, high-level risks, and at most three direct-diff P3/nit hygiene candidates",
    }),
    Object.freeze({
      id: "conventions-maintainability",
      tier: "medium",
      objective:
        "convention compliance, readability, maintainability, and test gaps, including substantiated nits",
    }),
    Object.freeze({
      id: "correctness",
      tier: "heavy",
      objective:
        "state-transition, ordering, async-lifecycle, concurrency, and cancellation defects, including lower-severity smells",
    }),
    Object.freeze({
      id: "correctness-contracts",
      tier: "heavy",
      objective:
        "compile, type, API/data/error-contract, boundary, integration, and wrong-transformation defects, including missing edge cases",
    }),
    Object.freeze({
      id: "security-performance",
      tier: "heavy",
      objective: "security vulnerabilities, including minor substantiated issues",
    }),
    Object.freeze({
      id: "performance-resources",
      tier: "heavy",
      objective:
        "performance, resource cleanup/ownership, scalability, I/O, memory, and contention defects",
    }),
  ]),
  deep: Object.freeze([
    Object.freeze({
      id: "deep-review",
      tier: "heavy",
      objective:
        "integrated whole-PR review: intent, implementation, callers, tests, and risks, reporting every substantiated severity",
    }),
  ]),
});

export function isReviewMode(mode) {
  return Object.prototype.hasOwnProperty.call(LANE_TOPOLOGIES, mode);
}

// One-line lane-list description for progress/report headers, e.g.
// "5 lanes (1 light, 4 heavy)". Works for any resolved lane list (C1 custom
// modes compose built-in lanes and custom roles).
export function describeLanes(lanes) {
  const counts = new Map();
  for (const lane of lanes) counts.set(lane.tier, (counts.get(lane.tier) ?? 0) + 1);
  const parts = ["light", "medium", "heavy"]
    .filter((tier) => counts.has(tier))
    .map((tier) => `${counts.get(tier)} ${tier}`);
  return `${lanes.length} lane${lanes.length === 1 ? "" : "s"} (${parts.join(", ")})`;
}

// Standard-topology convenience; custom modes resolve their lane list first
// (roles.resolveMode) and use describeLanes.
export function describeTopology(mode) {
  return describeLanes(LANE_TOPOLOGIES[mode]);
}
