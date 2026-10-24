#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// The hook must never block or break a commit: a slow or throwing hook body
// is worse than a skipped one. runHook() does the real work; main() races
// it against a 2s timeout and logs (rather than surfaces) any failure.
const HOOK_TIMEOUT_MS = 2000;

const stackmemPath = join(process.cwd(), ".stackmem");
let PROJECT;
try {
  PROJECT = readFileSync(stackmemPath, "utf8").trim();
} catch {
  process.exit(0); // no .stackmem, skip silently
}

const CLI_PATH = "/Users/aruna/coding-memory/coding-memory/dist/cli.js";

// Inlined copy of src/config-file.ts's defaults/merge logic — this script
// runs standalone with no import access to that module.
const DEFAULT_STACKMEM_CONFIG = {
  ignore: [],
  tokenBudget: 2000,
  decayLambda: 0.05,
  captureTypes: ["decision", "constraint", "discovery", "rejection"],
  minQualityScore: 0.3,
};

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function readStackmemConfig() {
  const configPath = join(process.cwd(), ".stackmem.json");
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
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
    };
  } catch {
    return { ...DEFAULT_STACKMEM_CONFIG };
  }
}

function matchesIgnorePattern(filePath, pattern) {
  const base = filePath.split("/").pop() ?? filePath;

  if (pattern.endsWith("/")) {
    const dirName = pattern.slice(0, -1);
    return filePath.split("/").includes(dirName);
  }

  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"
    );
    return regex.test(base) || regex.test(filePath);
  }

  return filePath === pattern || base === pattern;
}

const STACKMEM_CONFIG = readStackmemConfig();

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,
  /(api[_-]?key|apikey)\s*[:=]\s*["']?[\w-]{20,}["']?/gi,
  /bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/g,
  /^[A-Z_]+=.{8,}/gm,
];

const HIGH_ENTROPY_RE = /[a-zA-Z0-9+/]{40,}={0,2}/g;
const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 4.5;

function shannonEntropy(text) {
  if (text.length === 0) return 0;
  const counts = new Map();
  for (const char of text) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// Inlined copy of src/scoring.ts's redactSecrets — this script runs
// standalone via git's post-commit, with no import access to that module.
function redactSecrets(content) {
  let result = content;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  result = result.replace(HIGH_ENTROPY_RE, (match) =>
    shannonEntropy(match) > HIGH_ENTROPY_MIN_BITS_PER_CHAR ? "[REDACTED]" : match
  );
  return result;
}

function logHookError(error) {
  try {
    const logPath = join(process.cwd(), ".coding-memory", "hook.log");
    mkdirSync(dirname(logPath), { recursive: true });
    const message = error instanceof Error ? (error.stack || error.message) : String(error);
    appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Logging itself failed — nothing more we can safely do without
    // risking the commit, so give up silently.
  }
}

async function runHook() {

function git(args) {
  return execFileSync("git", args, { encoding: "utf-8" }).trim();
}

const CURRENT_SHA = git(["rev-parse", "HEAD"]);
const CURRENT_AUTHOR = (() => {
  try {
    return git(["log", "--format=%ae", "-1", "HEAD"]);
  } catch {
    return "";
  }
})();

// post-commit and post-rewrite both run this exact script against current
// HEAD, so a single operation that fires both (e.g. `git commit --amend`)
// would otherwise capture the same commit twice. Checked once up front,
// not per-save — see cmdCheckCommit in src/cli.ts for why.
try {
  execFileSync("node", [CLI_PATH, "check-commit", PROJECT, CURRENT_SHA], { stdio: "pipe" });
} catch {
  return;
}

// file_paths is populated with every file the commit touched (not just
// the filtered diffableFiles below) — "cm why <file>" should still find
// a commit's decision/discovery even if that specific file's own diff
// content was skipped as noise (a lockfile, say).
function cmSave(type, content) {
  if (!STACKMEM_CONFIG.captureTypes.includes(type)) return;

  const args = [
    CLI_PATH, "save", PROJECT, type, content, "--force",
    "--commit-sha", CURRENT_SHA,
    "--source", "hook",
    "--confidence", "0.8",
  ];
  if (CURRENT_AUTHOR) args.push("--author", CURRENT_AUTHOR);
  if (changedFiles.length > 0) args.push("--files", changedFiles.join(","));

  execFileSync("node", args, { stdio: "inherit" });
  savedItems.push(`${type}: ${content}`);
}

function basename(filePath) {
  return filePath.split("/").pop() ?? filePath;
}

function isConfigFile(filePath) {
  const base = basename(filePath);
  return (
    /\.config\.(ts|js)$/.test(base) ||
    base.startsWith("docker-compose") ||
    base === "Dockerfile" ||
    base === "nginx.conf" ||
    base.startsWith(".eslintrc") ||
    base.startsWith(".prettierrc")
  );
}

function isSchemaFile(filePath) {
  return (
    /migration/i.test(filePath) ||
    filePath.includes("schema.prisma") ||
    filePath.includes("schema.sql")
  );
}

// Noise that's never worth diffing: lockfiles, build output, vendored/
// generated code, and timestamp-prefixed SQL migrations (their content is
// a mechanical dump, not a human decision). Checked against path segments
// (not just a prefix) so "apps/web/dist/bundle.js" is skipped too, not
// just a top-level "dist/...".
const DIFF_SKIP_DIR_NAMES = new Set(["dist", "build", ".next", "coverage", "vendored", "node_modules"]);
const DIFF_SKIP_LOCK_NAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const MIGRATION_FILE_RE = /^\d{14}_.*\.sql$/;
const DIFF_MAX_BYTES = 50 * 1024;

function shouldSkipDiffFile(filePath) {
  const base = basename(filePath);
  if (filePath.split("/").some((segment) => DIFF_SKIP_DIR_NAMES.has(segment))) return true;
  if (DIFF_SKIP_LOCK_NAMES.has(base) || base.endsWith(".lock")) return true;
  if (base.endsWith(".min.js") || base.endsWith(".min.css")) return true;
  if (base.endsWith(".map")) return true;
  if (base.endsWith(".pb.go")) return true;
  if (/\.generated\./.test(base)) return true;
  if (MIGRATION_FILE_RE.test(base)) return true;
  if (STACKMEM_CONFIG.ignore.some((pattern) => matchesIgnorePattern(filePath, pattern))) return true;
  return false;
}

const LOW_QUALITY_PREFIXES = [
  "wip", "fix", "update", "misc", "temp", "test", "patch", "minor",
  "tweak", "change", "stuff", "done", "commit", "save", "ok", "m", "x",
];

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

// Filters out lazy/placeholder commit messages ("wip", "fix", "m", "...")
// and bare version bumps ("1.0.4") so only messages worth remembering
// become decisions. Checked against the first word, not a raw prefix
// match, so a real message like "Migrate auth to JWT" isn't rejected just
// for starting with the letter "m".
function isQualityCommitMessage(message) {
  const trimmed = message.trim();
  if (trimmed.length < 15) return false;
  if (SEMVER_RE.test(trimmed)) return false;
  if (!trimmed.includes(" ")) return false;

  const stripped = trimmed.replace(/\s/g, "");
  if (stripped.length > 0 && new Set(stripped).size === 1) return false;

  const lowerTrimmed = trimmed.toLowerCase();
  if (LOW_QUALITY_PREFIXES.includes(lowerTrimmed)) return false;

  const firstWord = (lowerTrimmed.match(/^[a-z0-9]+/) || [""])[0];
  if (LOW_QUALITY_PREFIXES.includes(firstWord)) return false;

  return true;
}

const savedItems = [];

const commitMessage = git(["log", "-1", "--pretty=%B"]);

// Kept as a general escape hatch for other automation (CI bots, scripts)
// that tags its own commits this way and shouldn't be captured as a
// memory — cm sync no longer self-commits, so this isn't load-bearing for
// that anymore, but other tools' commits still deserve the same skip.
if (commitMessage.includes("[skip ci]")) {
  return;
}

const isFirstCommit = (() => {
  try {
    execFileSync("git", ["rev-parse", "HEAD~1"], { stdio: "pipe" });
    return false;
  } catch {
    return true;
  }
})();

const changedFiles = git(
  isFirstCommit
    ? ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", "HEAD"]
    : ["diff-tree", "--no-commit-id", "-r", "--name-only", "HEAD"]
)
  .split("\n")
  .filter(Boolean);

let diff = "";
if (!isFirstCommit) {
  // --numstat marks a binary file's added/deleted columns as "-" — that's
  // the cheapest way to identify them without fetching their (useless,
  // and potentially huge) diff content at all.
  let binaryFiles = new Set();
  try {
    const numstat = execFileSync("git", ["diff", "--numstat", "HEAD~1", "HEAD"], {
      encoding: "utf-8",
    });
    for (const line of numstat.split("\n")) {
      const parts = line.split("\t");
      if (parts[0] === "-" && parts[1] === "-" && parts[2]) {
        binaryFiles.add(parts[2]);
      }
    }
  } catch {
    // Nothing to compare against — leave binaryFiles empty.
  }

  const diffableFiles = changedFiles.filter(
    (file) => !binaryFiles.has(file) && !shouldSkipDiffFile(file)
  );

  if (diffableFiles.length > 0) {
    try {
      diff = execFileSync("git", ["diff", "HEAD~1", "HEAD", "--", ...diffableFiles], {
        encoding: "utf-8",
      });
    } catch {
      diff = "";
    }
  }

  if (diff.length > DIFF_MAX_BYTES) {
    diff = diff.slice(0, DIFF_MAX_BYTES) + "\n\n... [diff truncated: exceeded 50KB after filtering]\n";
  }
}

const lines = diff.split("\n");
let currentFile = null;
let isNewFile = false;
let inDependenciesSection = false;

for (const line of isFirstCommit ? [] : lines) {
  if (line.startsWith("diff --git")) {
    isNewFile = false;
    inDependenciesSection = false;
  }
  if (line.startsWith("new file mode")) {
    isNewFile = true;
  }

  if (line.startsWith("+++ ")) {
    let filePath = line.slice(4);
    if (filePath.startsWith("b/")) filePath = filePath.slice(2);
    currentFile = filePath;

    if (isNewFile) {
      if (/(auth|login|session|token)/i.test(currentFile)) {
        const content = redactSecrets(`new auth-related file: ${currentFile}`);
        cmSave("discovery", content);
      }
      if (isConfigFile(currentFile)) {
        const content = redactSecrets(`new config: ${currentFile}`);
        cmSave("constraint", content);
      }
      if (isSchemaFile(currentFile)) {
        const content = redactSecrets(`schema change: ${currentFile}`);
        cmSave("discovery", content);
      }
    }
    continue;
  }

  const isPackageJson = currentFile != null && basename(currentFile) === "package.json";
  if (isPackageJson) {
    const rawLine =
      line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")
        ? line.slice(1)
        : line;
    if (/"(dependencies|devDependencies)"\s*:\s*\{/.test(rawLine)) {
      inDependenciesSection = true;
    } else if (inDependenciesSection && /^\s*\}/.test(rawLine)) {
      inDependenciesSection = false;
    }
  }

  if (line.startsWith("-") && !line.startsWith("---")) {
    const codeLine = line.slice(1).trim();

    const importMatch = line.match(
      /^-\s*(import\s+.*\s+from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"])/
    );
    const requireMatch = line.match(
      /^-\s*(?:const|let|var)\s+\S+\s*=\s*require\(['"]([^'"]+)['"]\)/
    );
    const removedModulePath = importMatch
      ? importMatch[2] || importMatch[3]
      : requireMatch
        ? requireMatch[1]
        : null;

    if (removedModulePath) {
      const content = redactSecrets(`removed dependency: ${removedModulePath}`);
      cmSave("rejection", content);
    }

    if (isPackageJson && inDependenciesSection) {
      const pkgMatch = codeLine.match(/"([a-z][\w-]+)"\s*:/);
      if (pkgMatch && pkgMatch[1] !== "dependencies" && pkgMatch[1] !== "devDependencies") {
        const content = redactSecrets(`removed dependency: ${pkgMatch[1]}`);
        cmSave("rejection", content);
      }
    }
    continue;
  }

  if (line.startsWith("+") && !line.startsWith("+++")) {
    const codeLine = line.slice(1);

    if (currentFile) {
      const base = basename(currentFile);
      if (base === ".env" || base === ".env.example") {
        const envMatch = codeLine.match(/([A-Z_]{3,})=/);
        if (envMatch) {
          const content = redactSecrets(`new env var required: ${envMatch[1]}`);
          cmSave("constraint", content);
        }
      }
    }

    if (isPackageJson && inDependenciesSection) {
      const pkgMatch = codeLine.match(/"([a-z][\w-]+)"\s*:/);
      if (pkgMatch && pkgMatch[1] !== "dependencies" && pkgMatch[1] !== "devDependencies") {
        const content = redactSecrets(`added dependency: ${pkgMatch[1]}`);
        cmSave("decision", content);
      }
    }

    if (currentFile && isSchemaFile(currentFile) && /CREATE TABLE|ALTER TABLE|DROP TABLE/i.test(codeLine)) {
      const truncated = codeLine.trim().slice(0, 80);
      const content = redactSecrets(`database change: ${truncated}`);
      cmSave("discovery", content);
    }

    if (/^\+\s*(\/\/|#)\s*(TODO:|FIXME:|HACK:|XXX:)/.test(line)) {
      const truncated = codeLine.trim().slice(0, 100);
      const content = redactSecrets(`open issue from commit: ${truncated}`);
      cmSave("discovery", content);
    }
  }
}

// Conventional-commit routing (handled last, after every diff-detected
// memory — diff analysis always runs regardless of commit message):
// feat/fix/perf/refactor save as a decision outright (the "type:" prefix is
// itself the quality signal, so the generic filter below is bypassed);
// docs/style/test/ci/build/chore are skipped entirely; a BREAKING CHANGE
// footer always saves as a constraint, independent of (and in addition to)
// the type-based routing above; anything that isn't a recognized
// conventional-commit type at all falls back to the pre-existing
// isQualityCommitMessage filter.
const CONVENTIONAL_COMMIT_RE = /^([a-zA-Z]+)(\([^)]*\))?!?:\s*(.+)/;
const CONVENTIONAL_DECISION_TYPES = new Set(["feat", "fix", "perf", "refactor"]);
const CONVENTIONAL_SKIP_TYPES = new Set(["docs", "style", "test", "ci", "build", "chore"]);
const BREAKING_CHANGE_RE = /BREAKING CHANGE:\s*([\s\S]+?)(?:\n\n|$)/;

const trimmedCommitMessage = commitMessage.trim();
const commitFirstLine = trimmedCommitMessage.split("\n")[0];
const conventionalMatch = commitFirstLine.match(CONVENTIONAL_COMMIT_RE);
const conventionalType = conventionalMatch ? conventionalMatch[1].toLowerCase() : null;

const breakingMatch = trimmedCommitMessage.match(BREAKING_CHANGE_RE);
if (breakingMatch) {
  const breakingContent = redactSecrets(breakingMatch[1].trim());
  const content = `BREAKING CHANGE: ${breakingContent}`;
  cmSave("constraint", content);
}

if (conventionalType && CONVENTIONAL_DECISION_TYPES.has(conventionalType)) {
  const trimmedMessage = redactSecrets(trimmedCommitMessage);
  cmSave("decision", trimmedMessage);
} else if (conventionalType && CONVENTIONAL_SKIP_TYPES.has(conventionalType)) {
  // docs/style/test/ci/build/chore — skip entirely, nothing saved.
} else if (isQualityCommitMessage(commitMessage)) {
  const trimmedMessage = redactSecrets(trimmedCommitMessage);
  cmSave("decision", trimmedMessage);
}

console.log(`coding-memory post-commit summary (${changedFiles.length} file(s) changed):`);
for (const item of savedItems) {
  console.log(`  - ${item}`);
}

// Updates .cursorrules/.windsurfrules on disk only — no git add/commit.
// Editors read these files straight off disk, and they're gitignored by
// default (see DEFAULT_GITIGNORE_CONTENT), so there's nothing to keep in
// sync with git history; committing them here used to double the commit
// count on every real commit and produced constant rules-file merge
// conflicts on teams.
execFileSync("node", [CLI_PATH, "sync"], { stdio: "inherit" });
}

async function main() {
  let timeoutHandle;
  try {
    await Promise.race([
      runHook(),
      new Promise((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error("stackmem post-commit hook exceeded " + HOOK_TIMEOUT_MS + "ms timeout")),
          HOOK_TIMEOUT_MS
        );
      }),
    ]);
  } catch (error) {
    logHookError(error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

main().finally(() => process.exit(0));
