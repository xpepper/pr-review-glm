// C1: custom review roles — user-defined reviewer lanes composed into modes.
// A role is a prompt plus a tier (the budget/fallback class) with optional
// model/effort overrides that fall back to the tier's values. Modes become
// ordered lane lists over the code-owned standard defaults (topologies.mjs),
// overridable and extendable in config. Roles are edited directly in the
// config file (the key=value grammar doesn't fit multi-line prompts).
//
// A role's prompt is MODEL INPUT, never authority: the resolved lane is an
// ordinary lane descriptor, so its findings flow through the same shaping,
// budgets, and (future I5/I7) validation/adjudication/publication gates as
// built-in lanes. Nothing here can raise severity, skip anchors, or unblock a
// merge.

import { LANE_TOPOLOGIES } from "./topologies.mjs";

// Built-in lane ids across all standard topologies, with the resolution order
// for ids reused between modes: quick → balanced → full → deep, first match.
// The standard topologies define a few ids with mode-specific objectives
// (e.g. "correctness" gains "including lower-severity smells" in full); a
// custom mode referencing a built-in id gets the first definition in that
// order — the baseline variant. This keeps id resolution unambiguous without
// a qualified-id grammar.
export function builtinLaneIndex() {
  const index = new Map();
  for (const mode of Object.keys(LANE_TOPOLOGIES)) {
    for (const lane of LANE_TOPOLOGIES[mode]) {
      if (!index.has(lane.id)) index.set(lane.id, lane);
    }
  }
  return index;
}

export function builtinLaneIds() {
  return [...builtinLaneIndex().keys()];
}

class RoleError extends Error {
  constructor(reason) {
    super(`Cannot resolve review mode: ${reason}`);
    this.reason = reason;
  }
}

// Resolves a mode name into its ordered lane list: config.modes[mode] when
// present (a standard name there OVERRIDES the built-in topology — the
// code-owned defaults exist to be composed over), otherwise the built-in
// topology. Each entry id resolves to a custom role when one is defined
// (roles shadow nothing: config validation rejects role ids that collide
// with built-in lane ids), otherwise to the built-in lane. A role lane
// carries its model/effort overrides for lane.mjs/batch.mjs to apply over
// the tier's values.
export function resolveMode(mode, config) {
  const customModes = config?.modes ?? {};
  const roles = config?.roles ?? {};
  // Standard topology entries are already lane descriptors; a config mode is
  // an ordered id list to resolve.
  if (!Object.prototype.hasOwnProperty.call(customModes, mode)) {
    const lanes = LANE_TOPOLOGIES[mode];
    if (lanes === undefined) {
      throw new RoleError(`unknown mode "${mode}" (not a standard mode and not defined in config.modes)`);
    }
    return [...lanes];
  }
  const builtin = builtinLaneIndex();
  const lanes = customModes[mode].map((id) => {
    if (Object.prototype.hasOwnProperty.call(roles, id)) {
      const role = roles[id];
      const lane = {
        id,
        tier: role.tier,
        objective: role.prompt,
        custom: true,
      };
      if (role.model !== undefined) lane.model = role.model;
      if (role.effort !== undefined) lane.effort = role.effort;
      return lane;
    }
    const builtinLane = builtin.get(id);
    if (builtinLane === undefined) {
      throw new RoleError(
        `mode "${mode}" references "${id}", which is neither a defined role nor a built-in lane id`,
      );
    }
    return builtinLane;
  });
  if (lanes.length === 0) {
    throw new RoleError(`mode "${mode}" has an empty lane list`);
  }
  return lanes;
}

// All modes a user can select via config.defaultMode: the four standard ones
// plus every config-defined mode name.
export function selectableModes(config) {
  return [...Object.keys(LANE_TOPOLOGIES), ...Object.keys(config?.modes ?? {})];
}
