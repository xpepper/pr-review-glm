import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Personal configuration for z-pr-review. The whole object is validated as a
// unit: a file that is partial or malformed is rejected and the last valid
// state stays active (spec: "Error handling").

export const CONFIG_SCHEMA_VERSION = 1;

// Renamed from "pr-review-glm" by R1 (2026-09-10). The store is user-local and
// schema-versioned, so the rename starts fresh at the new path — no migration.
export const CONFIG_DIR_NAME = "z-pr-review";
export const CONFIG_FILE_NAME = "config.json";

export const TIER_NAMES = ["light", "medium", "heavy"];

// Mirrors `copilot --effort` (Copilot CLI 1.0.83).
export const DEFAULT_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export const REVIEW_MODES = ["quick", "balanced", "full", "deep"];

// Budget defaults from the spec ("Degradation and budgets"): attempt caps
// 3m light / 6m medium / 12m heavy, one fallback attempt <= 3m, 12m batch from
// first dispatch, 60s adjudication, 15m total hard cap including cleanup.
const DEFAULT_DEADLINES_MS = Object.freeze({
  attemptMs: Object.freeze({
    light: 180_000,
    medium: 360_000,
    heavy: 720_000,
  }),
  fallbackMs: 180_000,
  batchMs: 720_000,
  adjudicationMs: 60_000,
  totalMs: 900_000,
});

// A tier model of null means "use the session's model at review time" (resolved
// when lanes are spawned, never from model-influenced text).
export function defaultConfig() {
  return structuredClone({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    tiers: {
      light: { model: null, effort: "low" },
      medium: { model: null, effort: "medium" },
      heavy: { model: null, effort: "high" },
    },
    defaultMode: "balanced",
    autoPostReviews: false,
    deadlines: DEFAULT_DEADLINES_MS,
  });
}

export function defaultConfigPath() {
  return join(homedir(), ".copilot", CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkExactKeys(value, keys, label, errors) {
  for (const present of Object.keys(value)) {
    if (!keys.includes(present)) {
      errors.push(`${label}: unknown key "${present}"`);
    }
  }
  for (const required of keys) {
    if (!(required in value)) {
      errors.push(`${label}: missing key "${required}"`);
    }
  }
}

function isPositiveMs(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function checkTier(tier, name, errors) {
  const label = `tiers.${name}`;
  for (const present of Object.keys(tier)) {
    if (!["model", "effort", "fallback"].includes(present)) {
      errors.push(`${label}: unknown key "${present}"`);
    }
  }
  for (const required of ["model", "effort"]) {
    if (!(required in tier)) {
      errors.push(`${label}: missing key "${required}"`);
    }
  }
  if ("effort" in tier && !DEFAULT_EFFORTS.includes(tier.effort)) {
    errors.push(`${label}.effort must be one of: ${DEFAULT_EFFORTS.join(", ")}`);
  }
  if ("model" in tier && tier.model !== null && (typeof tier.model !== "string" || tier.model.length === 0)) {
    errors.push(`${label}.model must be a non-empty model id or null (session model)`);
  }
  if ("fallback" in tier && tier.fallback !== undefined) {
    if (typeof tier.fallback !== "string" || tier.fallback.length === 0) {
      errors.push(`${label}.fallback must be a non-empty model id`);
    } else if (tier.fallback === tier.model) {
      errors.push(`${label}.fallback must differ from ${label}.model`);
    }
  }
}

export function validateConfig(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { valid: false, errors: ["config must be a JSON object"] };
  }
  checkExactKeys(
    value,
    ["schemaVersion", "tiers", "defaultMode", "autoPostReviews", "deadlines"],
    "config",
    errors,
  );
  if ("schemaVersion" in value && value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    errors.push(
      `config.schemaVersion must be ${CONFIG_SCHEMA_VERSION} (found ${JSON.stringify(value.schemaVersion)})`,
    );
  }
  if ("tiers" in value && isPlainObject(value.tiers)) {
    checkExactKeys(value.tiers, TIER_NAMES, "tiers", errors);
    for (const name of TIER_NAMES) {
      if (name in value.tiers && isPlainObject(value.tiers[name])) {
        checkTier(value.tiers[name], name, errors);
      } else if (name in value.tiers) {
        errors.push(`tiers.${name} must be an object`);
      }
    }
  } else if ("tiers" in value) {
    errors.push("config.tiers must be an object");
  }
  if ("defaultMode" in value && !REVIEW_MODES.includes(value.defaultMode)) {
    errors.push(`config.defaultMode must be one of: ${REVIEW_MODES.join(", ")}`);
  }
  if ("autoPostReviews" in value && typeof value.autoPostReviews !== "boolean") {
    errors.push("config.autoPostReviews must be a boolean");
  }
  if ("deadlines" in value && isPlainObject(value.deadlines)) {
    const deadlines = value.deadlines;
    checkExactKeys(
      deadlines,
      ["attemptMs", "fallbackMs", "batchMs", "adjudicationMs", "totalMs"],
      "deadlines",
      errors,
    );
    if ("attemptMs" in deadlines && isPlainObject(deadlines.attemptMs)) {
      checkExactKeys(deadlines.attemptMs, TIER_NAMES, "deadlines.attemptMs", errors);
      for (const name of TIER_NAMES) {
        if (name in deadlines.attemptMs && !isPositiveMs(deadlines.attemptMs[name])) {
          errors.push(`deadlines.attemptMs.${name} must be a positive integer (milliseconds)`);
        }
      }
    } else if ("attemptMs" in deadlines) {
      errors.push("deadlines.attemptMs must be an object");
    }
    for (const key of ["fallbackMs", "batchMs", "adjudicationMs", "totalMs"]) {
      if (key in deadlines && !isPositiveMs(deadlines[key])) {
        errors.push(`deadlines.${key} must be a positive integer (milliseconds)`);
      }
    }
    const { attemptMs, batchMs, adjudicationMs, totalMs } = deadlines;
    if (isPositiveMs(totalMs)) {
      if (isPositiveMs(batchMs) && totalMs <= batchMs) {
        errors.push("deadlines.totalMs must exceed deadlines.batchMs");
      }
      const largestAttempt = isPlainObject(attemptMs)
        ? Math.max(...TIER_NAMES.filter((n) => isPositiveMs(attemptMs[n])).map((n) => attemptMs[n]), 0)
        : 0;
      if (totalMs <= largestAttempt) {
        errors.push("deadlines.totalMs must exceed every deadlines.attemptMs value");
      }
      if (isPositiveMs(adjudicationMs) && totalMs <= adjudicationMs) {
        errors.push("deadlines.totalMs must exceed deadlines.adjudicationMs");
      }
    }
  } else if ("deadlines" in value) {
    errors.push("config.deadlines must be an object");
  }
  return errors.length ? { valid: false, errors } : { valid: true };
}

export function configDirectoryFor(filePath) {
  return dirname(filePath);
}

// Leaf paths reachable by set/unset. Object paths and schemaVersion are
// deliberately absent: the config is only ever edited key by key.
const SETTABLE_LEAF_PATHS = [
  ...TIER_NAMES.flatMap((tier) => [
    `tiers.${tier}.model`,
    `tiers.${tier}.effort`,
    `tiers.${tier}.fallback`,
  ]),
  "defaultMode",
  "autoPostReviews",
  "deadlines.attemptMs.light",
  "deadlines.attemptMs.medium",
  "deadlines.attemptMs.heavy",
  "deadlines.fallbackMs",
  "deadlines.batchMs",
  "deadlines.adjudicationMs",
  "deadlines.totalMs",
];

export class ConfigError extends Error {
  constructor(problems) {
    super(problems.join("; "));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

function parsePath(path) {
  if (!SETTABLE_LEAF_PATHS.includes(path)) {
    return { known: false };
  }
  return { known: true, segments: path.split(".") };
}

function coerceValue(path, raw) {
  if (typeof raw !== "string") {
    return { value: raw };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { problem: `${path}: value must not be empty` };
  }
  if (trimmed === "true") return { value: true };
  if (trimmed === "false") return { value: false };
  if (/^[0-9]+$/.test(trimmed)) return { value: Number(trimmed) };
  if (/[\u0000-\u001f]/.test(trimmed)) {
    return { problem: `${path}: value must not contain control characters` };
  }
  return { value: trimmed };
}

function resolveSegments(config, segments) {
  let node = config;
  for (const segment of segments.slice(0, -1)) {
    node = node[segment];
  }
  return node;
}

function valueAtPath(config, segments) {
  let node = config;
  for (const segment of segments) {
    node = node?.[segment];
  }
  return node;
}

function setValueAtPath(config, segments, value) {
  const parent = resolveSegments(config, segments);
  parent[segments.at(-1)] = value;
}

function removeKeyAtPath(config, segments) {
  const parent = resolveSegments(config, segments);
  delete parent[segments.at(-1)];
}

export class ConfigStore {
  constructor(path = defaultConfigPath()) {
    this.path = path;
    this.#config = defaultConfig();
    this.#source = "defaults";
    this.#warnings = [];
    this.#fileRejected = false;
  }

  #config;
  #source;
  #warnings;
  #fileRejected;

  get() {
    return this.#config;
  }

  get source() {
    return this.#source;
  }

  get warnings() {
    return [...this.#warnings];
  }

  async load() {
    this.#warnings = [];
    this.#fileRejected = false;
    let raw;
    try {
      raw = await import("node:fs/promises").then((fs) => fs.readFile(this.path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        this.#config = defaultConfig();
        this.#source = "defaults";
        return this.#snapshot();
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#rejectFile("is not valid JSON");
      return this.#snapshot();
    }
    const result = validateConfig(parsed);
    if (!result.valid) {
      this.#rejectFile(`fails validation: ${result.errors.join("; ")}`);
      return this.#snapshot();
    }
    this.#config = parsed;
    this.#source = "file";
    return this.#snapshot();
  }

  #rejectFile(reason) {
    // A load-time rejection has no prior in-session state to keep, so the
    // defaults activate (set/unset then refuse to write until the file is
    // fixed); the file itself is left untouched.
    this.#config = defaultConfig();
    this.#source = "defaults";
    this.#warnings = [
      `Ignoring ${this.path}: ${reason}. Using defaults; fix or remove the file to re-enable it.`,
    ];
    this.#fileRejected = true;
  }

  #snapshot() {
    return { config: this.#config, source: this.#source, warnings: this.warnings };
  }

  async #write(config) {
    const fs = await import("node:fs/promises");
    const directory = configDirectoryFor(this.path);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    // Write-then-rename keeps readers from ever seeing a partial file; the
    // chmod happens on the temp file so the final name never has a wider mode.
    const tempPath = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await fs.chmod(tempPath, 0o600);
      await fs.rename(tempPath, this.path);
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      throw error;
    }
  }

  async set(entries) {
    const problems = [];
    const parsedEntries = entries.map(([path, raw]) => {
      const { known, segments } = parsePath(path);
      if (!known) {
        problems.push(`unknown config key "${path}"`);
        return null;
      }
      const coerced = coerceValue(path, raw);
      if (coerced.problem) {
        problems.push(coerced.problem);
        return null;
      }
      return { segments, value: coerced.value };
    });
    if (problems.length) {
      throw new ConfigError(problems);
    }
    const next = structuredClone(this.#config);
    for (const { segments, value } of parsedEntries) {
      setValueAtPath(next, segments, value);
    }
    await this.#commit(next);
  }

  async unset(paths) {
    const problems = paths
      .filter((path) => !parsePath(path).known)
      .map((path) => `unknown config key "${path}"`);
    if (problems.length) {
      throw new ConfigError(problems);
    }
    const defaults = defaultConfig();
    const next = structuredClone(this.#config);
    for (const path of paths) {
      const segments = path.split(".");
      if (valueAtPath(defaults, segments) === undefined) {
        removeKeyAtPath(next, segments);
      } else {
        setValueAtPath(next, segments, valueAtPath(defaults, segments));
      }
    }
    await this.#commit(next);
  }

  async #commit(next) {
    if (this.#fileRejected) {
      throw new ConfigError([
        ...this.#warnings,
        "Fix or remove the file before changing settings, so nothing is overwritten blindly.",
      ]);
    }
    // The whole object is validated as a unit before anything is written.
    const result = validateConfig(next);
    if (!result.valid) {
      throw new ConfigError(result.errors);
    }
    await this.#write(next);
    this.#config = next;
    this.#source = "file";
    this.#warnings = [];
  }
}
