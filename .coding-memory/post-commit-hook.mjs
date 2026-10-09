#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const stackmemPath = join(process.cwd(), ".stackmem");
let PROJECT;
try {
  PROJECT = readFileSync(stackmemPath, "utf8").trim();
} catch {
  process.exit(0); // no .stackmem, skip silently
}

const CLI_PATH = "/Users/aruna/coding-memory/coding-memory/dist/cli.js";

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
  process.exit(0);
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
        const content = `new auth-related file: ${currentFile}`;
        cmSave("discovery", content);
        savedItems.push(`discovery: ${content}`);
      }
      if (isConfigFile(currentFile)) {
        const content = `new config: ${currentFile}`;
        cmSave("constraint", content);
        savedItems.push(`constraint: ${content}`);
      }
      if (isSchemaFile(currentFile)) {
        const content = `schema change: ${currentFile}`;
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
      const content = `removed dependency: ${removedModulePath}`;
      cmSave("rejection", content);
      savedItems.push(`rejection: ${content}`);
    }

    if (isPackageJson && inDependenciesSection) {
      const pkgMatch = codeLine.match(/"([a-z][\w-]+)"\s*:/);
      if (pkgMatch && pkgMatch[1] !== "dependencies" && pkgMatch[1] !== "devDependencies") {
        const content = `removed dependency: ${pkgMatch[1]}`;
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
          const content = `new env var required: ${envMatch[1]}`;
          cmSave("constraint", content);
          savedItems.push(`constraint: ${content}`);
        }
      }
    }

    if (isPackageJson && inDependenciesSection) {
      const pkgMatch = codeLine.match(/"([a-z][\w-]+)"\s*:/);
      if (pkgMatch && pkgMatch[1] !== "dependencies" && pkgMatch[1] !== "devDependencies") {
        const content = `added dependency: ${pkgMatch[1]}`;
        cmSave("decision", content);
        savedItems.push(`decision: ${content}`);
      }
    }

    if (currentFile && isSchemaFile(currentFile) && /CREATE TABLE|ALTER TABLE|DROP TABLE/i.test(codeLine)) {
      const truncated = codeLine.trim().slice(0, 80);
      const content = `database change: ${truncated}`;
      cmSave("discovery", content);
      savedItems.push(`discovery: ${content}`);
    }

    if (/^\+\s*(\/\/|#)\s*(TODO:|FIXME:|HACK:|XXX:)/.test(line)) {
      const truncated = codeLine.trim().slice(0, 100);
      const content = `open issue from commit: ${truncated}`;
      cmSave("discovery", content);
      savedItems.push(`discovery: ${content}`);
    }
  }
}

// Saved last, after every diff-detected memory, and only if it clears the
// quality filter — diff analysis always runs regardless of commit message.
if (isQualityCommitMessage(commitMessage)) {
  const trimmedMessage = commitMessage.trim();
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
