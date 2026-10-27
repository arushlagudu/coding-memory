import fs from "node:fs";
import path from "node:path";

export const STACKMEM_CONFIG_FILENAME = ".stackmem.json";

export interface StackmemConfig {
  ignore: string[];
  tokenBudget: number;
  decayLambda: number;
  captureTypes: string[];
  minQualityScore: number;
  localOnly: boolean;
  // When false, hook-captured memories skip the suggested-review queue
  // and are permanent immediately — see cmdSave's `source === "hook"`
  // suggested-flag logic in src/cli.ts. Set by `cm init --wizard`'s
  // "Enable suggested memory review?" prompt.
  suggestedReview: boolean;
}

export const DEFAULT_STACKMEM_CONFIG: StackmemConfig = {
  ignore: [],
  tokenBudget: 2000,
  decayLambda: 0.05,
  captureTypes: ["decision", "constraint", "discovery", "rejection"],
  minQualityScore: 0.3,
  localOnly: false,
  suggestedReview: true,
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// Every field is independently optional — a partial or malformed
// .stackmem.json falls back to the default for whichever fields it got
// wrong, rather than failing the whole read.
function mergeWithDefaults(parsed: unknown): StackmemConfig {
  const raw = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;

  return {
    ignore: isStringArray(raw.ignore) ? raw.ignore : DEFAULT_STACKMEM_CONFIG.ignore,
    tokenBudget:
      typeof raw.tokenBudget === "number" && raw.tokenBudget > 0
        ? raw.tokenBudget
        : DEFAULT_STACKMEM_CONFIG.tokenBudget,
    decayLambda:
      typeof raw.decayLambda === "number" && raw.decayLambda > 0
        ? raw.decayLambda
        : DEFAULT_STACKMEM_CONFIG.decayLambda,
    captureTypes: isStringArray(raw.captureTypes) ? raw.captureTypes : DEFAULT_STACKMEM_CONFIG.captureTypes,
    minQualityScore:
      typeof raw.minQualityScore === "number"
        ? raw.minQualityScore
        : DEFAULT_STACKMEM_CONFIG.minQualityScore,
    localOnly: typeof raw.localOnly === "boolean" ? raw.localOnly : DEFAULT_STACKMEM_CONFIG.localOnly,
    suggestedReview:
      typeof raw.suggestedReview === "boolean" ? raw.suggestedReview : DEFAULT_STACKMEM_CONFIG.suggestedReview,
  };
}

// Reads .stackmem.json from `projectRoot` (defaulting to cwd). Missing
// file, unreadable file, or invalid JSON all fall back to defaults
// silently — a config file is an optimization, never a hard requirement.
export function readStackmemConfig(projectRoot: string = process.cwd()): StackmemConfig {
  const configPath = path.join(projectRoot, STACKMEM_CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_STACKMEM_CONFIG };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return mergeWithDefaults(parsed);
  } catch {
    return { ...DEFAULT_STACKMEM_CONFIG };
  }
}

export function defaultConfigFileContents(): string {
  return JSON.stringify(DEFAULT_STACKMEM_CONFIG, null, 2) + "\n";
}

// Minimal glob support for the `ignore` list: a trailing "/" matches a
// directory name anywhere in the path (like "dist/" already does
// elsewhere in the hook's own skip list); "*" matches any run of
// characters. Everything else is an exact match against the basename or
// full path. Deliberately not a real glob engine — just enough for the
// documented ignore patterns ("dist/", "migrations/", "*.generated.*").
export function matchesIgnorePattern(filePath: string, pattern: string): boolean {
  const baseName = filePath.split("/").pop() ?? filePath;

  if (pattern.endsWith("/")) {
    const dirName = pattern.slice(0, -1);
    return filePath.split("/").includes(dirName);
  }

  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"
    );
    return regex.test(baseName) || regex.test(filePath);
  }

  return filePath === pattern || baseName === pattern;
}

export function isIgnoredByConfig(filePath: string, config: StackmemConfig): boolean {
  return config.ignore.some((pattern) => matchesIgnorePattern(filePath, pattern));
}
