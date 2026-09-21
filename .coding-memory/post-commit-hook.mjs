#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const PROJECT = "coding-memory";
const CLI_PATH = "/Users/aruna/coding-memory/coding-memory/src/cli.ts";

function git(args) {
  return execFileSync("git", args, { encoding: "utf-8" }).trim();
}

function cmSave(type, content) {
  execFileSync("npx", ["tsx", CLI_PATH, "save", PROJECT, type, content], {
    stdio: "inherit",
  });
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

for (const line of lines) {
  if (line.startsWith("diff --git")) {
    isNewFile = false;
  }
  if (line.startsWith("new file mode")) {
    isNewFile = true;
  }

  if (line.startsWith("+++ ")) {
    let filePath = line.slice(4);
    if (filePath.startsWith("b/")) filePath = filePath.slice(2);
    currentFile = filePath;
    if (isNewFile && /(auth|login|session|token)/i.test(currentFile)) {
      const content = `new auth-related file: ${currentFile}`;
      cmSave("discovery", content);
      savedItems.push(`discovery: ${content}`);
    }
    continue;
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
    continue;
  }

  if (line.startsWith("+") && !line.startsWith("+++") && currentFile) {
    const base = currentFile.split("/").pop() ?? currentFile;
    if (base === ".env" || base === ".env.example") {
      const codeLine = line.slice(1);
      const envMatch = codeLine.match(/([A-Z_]{3,})=/);
      if (envMatch) {
        const content = `new env var required: ${envMatch[1]}`;
        cmSave("constraint", content);
        savedItems.push(`constraint: ${content}`);
      }
    }
  }
}

console.log(`coding-memory post-commit summary (${changedFiles.length} file(s) changed):`);
for (const item of savedItems) {
  console.log(`  - ${item}`);
}
