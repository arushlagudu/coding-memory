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

function cmSave(type, content) {
  execFileSync("node", [CLI_PATH, "save", PROJECT, type, content, "--force"], {
    stdio: "inherit",
  });
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

// The sync commit below is itself a commit, so it fires this same
// post-commit hook again — git's --no-verify only skips pre-commit and
// commit-msg hooks, never post-commit. Without this guard, the hook would
// save its own commit message as a new decision memory, which changes the
// rules-file content and triggers another sync commit, indefinitely.
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
  try {
    diff = execFileSync("git", ["diff", "HEAD~1", "HEAD"], { encoding: "utf-8" });
  } catch {
    diff = "";
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
        savedItems.push(`discovery: ${content}`);
      }
      if (isConfigFile(currentFile)) {
        const content = redactSecrets(`new config: ${currentFile}`);
        cmSave("constraint", content);
        savedItems.push(`constraint: ${content}`);
      }
      if (isSchemaFile(currentFile)) {
        const content = redactSecrets(`schema change: ${currentFile}`);
        cmSave("discovery", content);
        savedItems.push(`discovery: ${content}`);
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
      savedItems.push(`rejection: ${content}`);
    }

    if (isPackageJson && inDependenciesSection) {
      const pkgMatch = codeLine.match(/"([a-z][\w-]+)"\s*:/);
      if (pkgMatch && pkgMatch[1] !== "dependencies" && pkgMatch[1] !== "devDependencies") {
        const content = redactSecrets(`removed dependency: ${pkgMatch[1]}`);
        cmSave("rejection", content);
        savedItems.push(`rejection: ${content}`);
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
          savedItems.push(`constraint: ${content}`);
        }
      }
    }

    if (isPackageJson && inDependenciesSection) {
      const pkgMatch = codeLine.match(/"([a-z][\w-]+)"\s*:/);
      if (pkgMatch && pkgMatch[1] !== "dependencies" && pkgMatch[1] !== "devDependencies") {
        const content = redactSecrets(`added dependency: ${pkgMatch[1]}`);
        cmSave("decision", content);
        savedItems.push(`decision: ${content}`);
      }
    }

    if (currentFile && isSchemaFile(currentFile) && /CREATE TABLE|ALTER TABLE|DROP TABLE/i.test(codeLine)) {
      const truncated = codeLine.trim().slice(0, 80);
      const content = redactSecrets(`database change: ${truncated}`);
      cmSave("discovery", content);
      savedItems.push(`discovery: ${content}`);
    }

    if (/^\+\s*(\/\/|#)\s*(TODO:|FIXME:|HACK:|XXX:)/.test(line)) {
      const truncated = codeLine.trim().slice(0, 100);
      const content = redactSecrets(`open issue from commit: ${truncated}`);
      cmSave("discovery", content);
      savedItems.push(`discovery: ${content}`);
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
  savedItems.push(`constraint: ${content}`);
}

if (conventionalType && CONVENTIONAL_DECISION_TYPES.has(conventionalType)) {
  const trimmedMessage = redactSecrets(trimmedCommitMessage);
  cmSave("decision", trimmedMessage);
  savedItems.push(`decision: ${trimmedMessage}`);
} else if (conventionalType && CONVENTIONAL_SKIP_TYPES.has(conventionalType)) {
  // docs/style/test/ci/build/chore — skip entirely, nothing saved.
} else if (isQualityCommitMessage(commitMessage)) {
  const trimmedMessage = redactSecrets(trimmedCommitMessage);
  cmSave("decision", trimmedMessage);
  savedItems.push(`decision: ${trimmedMessage}`);
}

console.log(`coding-memory post-commit summary (${changedFiles.length} file(s) changed):`);
for (const item of savedItems) {
  console.log(`  - ${item}`);
}

execFileSync("node", [CLI_PATH, "sync"], { stdio: "inherit" });

// cm sync rewrites .cursorrules/.windsurfrules, which would otherwise leave
// the working directory dirty (breaking things like `npm version patch`
// that require a clean tree). Commit the sync ourselves instead. --no-verify
// skips pre-commit/commit-msg hooks (not post-commit — see the [skip ci]
// guard above, which is what actually stops this from recursing).
try {
  execFileSync("git", ["add", ".cursorrules", ".windsurfrules"], { stdio: "pipe" });
  execFileSync("git", ["commit", "--no-verify", "-m", "chore: sync memory to rules files [skip ci]"], {
    stdio: "pipe",
  });
} catch {
  // Nothing to commit (rules files unchanged) — fine, ignore.
}
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
