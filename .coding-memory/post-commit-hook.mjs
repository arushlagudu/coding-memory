#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const PROJECT = "testproject";
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

const savedItems = [];

const commitMessage = git(["log", "-1", "--pretty=%B"]);
cmSave("decision", commitMessage);
savedItems.push(`decision: ${commitMessage}`);

const changedFiles = git(["diff-tree", "--no-commit-id", "-r", "--name-only", "HEAD"])
  .split("\n")
  .filter(Boolean);

let diff = "";
try {
  diff = execFileSync("git", ["diff", "HEAD~1", "HEAD"], { encoding: "utf-8" });
} catch {
  diff = "";
}

const lines = diff.split("\n");
let currentFile = null;
let isNewFile = false;
let inDependenciesSection = false;

for (const line of lines) {
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

    if (codeLine.startsWith("import") || codeLine.startsWith("require")) {
      const pathMatch = codeLine.match(/['"]([^'"]+)['"]/);
      const importPath = pathMatch ? pathMatch[1] : codeLine;
      const content = `removed dependency: ${importPath}`;
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

    if (/TODO:|FIXME:|HACK:|XXX:/.test(codeLine)) {
      const truncated = codeLine.trim().slice(0, 100);
      const content = `open issue from commit: ${truncated}`;
      cmSave("discovery", content);
      savedItems.push(`discovery: ${content}`);
    }
  }
}

console.log(`coding-memory post-commit summary (${changedFiles.length} file(s) changed):`);
for (const item of savedItems) {
  console.log(`  - ${item}`);
}
