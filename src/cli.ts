#!/usr/bin/env tsx
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { analyzeCodebase } from "./ast-index.js";
import {
  applyContextBudget,
  buildSummaryContent,
  clusterMemories,
  computeDecayScore,
  computeMemoryLinks,
  decideSaveAction,
  estimateTokens,
  scoreMemoryRelevance,
} from "./scoring.js";

const CONTEXT_BUDGET_TOKENS = 2000;
const COMPRESSION_THRESHOLD = 20;
const CLI_PATH = fileURLToPath(import.meta.url);

// Load this project's own .env by absolute path rather than relying on
// dotenv's default of process.cwd() — cm can be invoked (e.g. from a git
// post-commit hook via its full path) with the working directory set to
// some other repo entirely.
dotenv.config({ path: nodePath.join(nodePath.dirname(CLI_PATH), "..", ".env") });

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable (check .env)."
  );
}

const supabaseBaseUrl = SUPABASE_URL.replace(/\/rest\/v1\/?$/, "");
const supabase = createClient(supabaseBaseUrl, SUPABASE_SERVICE_ROLE_KEY);

const MEMORY_TYPES = ["decision", "rejection", "constraint", "discovery"] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

const TYPE_LABELS: Record<MemoryType, string> = {
  decision: "Decisions",
  constraint: "Constraints",
  discovery: "Discoveries",
  rejection: "Rejections",
};

function usage(): never {
  console.error(`Usage:
  cm start <project>
  cm save <project> <type> <content>      (type: decision|rejection|constraint|discovery)
  cm fix <project> <problem> <solution>
  cm analyze <project> <path>
  cm search <project> <query>
  cm resolve <project> <memory-id>
  cm delete <project> <memory-id>
  cm compress <project>
  cm init <project> <path>
  cm context <project> <task>
  cm help`);
  process.exit(1);
}

function cmdHelp() {
  console.log(`cm — coding memory CLI

  cm start <project>
      Load all unresolved memories for a project, sorted by decay
      score and capped at a 2000 token context budget, grouped by
      type (decisions, constraints, discoveries, rejections), with
      linked memory ids shown under each entry.

  cm save <project> <type> <content>
      Save a new memory. <type> is one of: decision, rejection,
      constraint, discovery. Automatically links to related existing
      memories.

  cm fix <project> <problem> <solution>
      Record a problem and its solution for future reference.

  cm analyze <project> <path>
      Build an AST index (files, functions, classes) for the codebase
      at <path>.

  cm search <project> <query>
      Search saved memories and past fixes for a project matching
      <query>.

  cm resolve <project> <memory-id>
      Mark a memory as resolved.

  cm delete <project> <memory-id>
      Delete a memory and any memory_links referencing it.

  cm compress <project>
      Cluster related unresolved memories (needs 20+) and collapse
      clusters of 3 or more into a single summary memory.

  cm init <project> <path>
      Install a git post-commit hook in the repo at <path> that
      records the commit message and any implicit memories (removed
      imports, new env vars, new auth-related files) after every
      commit.

  cm context <project> <task>
      Return only the top 5 memories most relevant to a specific
      task, ranked by a blend of task relevance and decay score,
      as a markdown block capped at a 2000 token budget.

  cm help
      Show this help message.`);
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

// --- cm start ----------------------------------------------------------

async function cmdStart(project: string) {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .eq("resolved", false);

  if (error) fail(`Failed to load memories: ${error.message}`);

  const memories = data ?? [];
  if (memories.length === 0) {
    console.log(`No memories found for "${project}".`);
    return;
  }

  const scoredMemories = memories
    .map((memory) => ({
      ...memory,
      decay_score: computeDecayScore(new Date(memory.created_at), memory.access_count ?? 0),
    }))
    .sort((a, b) => b.decay_score - a.decay_score);

  const budgetedMemories = applyContextBudget(scoredMemories, CONTEXT_BUDGET_TOKENS);
  const omittedCount = scoredMemories.length - budgetedMemories.length;
  const tokensUsed = budgetedMemories.reduce(
    (sum, memory) => sum + estimateTokens(memory.content),
    0
  );

  const memoryIds = budgetedMemories.map((m) => m.id);
  const linkedIdsByMemory = new Map<string, Set<string>>();

  const idList = memoryIds.join(",");
  const { data: links, error: linksError } = await supabase
    .from("memory_links")
    .select("source_id, target_id")
    .or(`source_id.in.(${idList}),target_id.in.(${idList})`);

  if (linksError) fail(`Failed to load memory links: ${linksError.message}`);

  for (const link of links ?? []) {
    if (!linkedIdsByMemory.has(link.source_id)) linkedIdsByMemory.set(link.source_id, new Set());
    if (!linkedIdsByMemory.has(link.target_id)) linkedIdsByMemory.set(link.target_id, new Set());
    linkedIdsByMemory.get(link.source_id)!.add(link.target_id);
    linkedIdsByMemory.get(link.target_id)!.add(link.source_id);
  }

  console.log(`Loaded ${scoredMemories.length} memory(ies) for "${project}".\n`);

  for (const type of MEMORY_TYPES) {
    const group = budgetedMemories.filter((m) => m.type === type);
    if (group.length === 0) continue;

    console.log(`${TYPE_LABELS[type]} (${group.length})`);
    console.log("-".repeat(TYPE_LABELS[type].length + 4));
    for (const memory of group) {
      console.log(`  [${memory.id}] (score: ${memory.decay_score.toFixed(2)}) ${memory.content}`);
      const linked = Array.from(linkedIdsByMemory.get(memory.id) ?? []);
      if (linked.length > 0) {
        console.log(`      linked: ${linked.join(", ")}`);
      }
    }
    console.log("");
  }

  console.log(`Context budget: ${tokensUsed}/${CONTEXT_BUDGET_TOKENS} tokens used`);
  if (omittedCount > 0) {
    console.log(`${omittedCount} memories omitted (budget exceeded)`);
  }

  const incrementResults = await Promise.all(
    budgetedMemories.map((memory) =>
      supabase
        .from("memories")
        .update({ access_count: (memory.access_count ?? 0) + 1 })
        .eq("id", memory.id)
    )
  );
  const incrementError = incrementResults.find((result) => result.error)?.error;
  if (incrementError) fail(`Failed to update access counts: ${incrementError.message}`);
}

// --- cm save -------------------------------------------------------------

async function cmdSave(project: string, type: string, content: string) {
  if (!MEMORY_TYPES.includes(type as MemoryType)) {
    fail(`Invalid type "${type}". Must be one of: ${MEMORY_TYPES.join(", ")}`);
  }

  const { data: existingRows, error: existingError } = await supabase
    .from("memories")
    .select("id, content")
    .eq("project", project)
    .eq("resolved", false);

  if (existingError) fail(`Failed to load memories: ${existingError.message}`);

  const existingMemories = existingRows ?? [];
  const decision = decideSaveAction(content, existingMemories);

  if (decision.action === "duplicate") {
    console.log("Duplicate memory detected — skipping.");
    return;
  }

  if (decision.action === "superseded") {
    const { error: resolveError } = await supabase
      .from("memories")
      .update({ resolved: true })
      .eq("id", decision.oldId);

    if (resolveError) fail(`Failed to resolve superseded memory: ${resolveError.message}`);
  }

  const { data: inserted, error } = await supabase
    .from("memories")
    .insert({ project, type, content })
    .select("id")
    .single();

  if (error || !inserted) fail(`Failed to save memory: ${error?.message ?? "no row returned"}`);

  const newMemoryId = inserted.id;
  const links = computeMemoryLinks(newMemoryId, content, existingMemories);

  if (links.length > 0) {
    const { error: linkError } = await supabase.from("memory_links").insert(links);
    if (linkError) fail(`Failed to save memory links: ${linkError.message}`);
  }

  if (decision.action === "superseded") {
    console.log(`Superseded previous memory [${decision.oldId}].`);
  }

  console.log(`Saved ${type} [${newMemoryId}] for "${project}".`);
  if (links.length > 0) {
    console.log(`Linked to ${links.length} existing memory(ies): ${links.map((l) => l.target_id).join(", ")}`);
  }

  const { count: unresolvedCount, error: countError } = await supabase
    .from("memories")
    .select("id", { count: "exact", head: true })
    .eq("project", project)
    .eq("resolved", false);

  if (countError) fail(`Failed to count memories: ${countError.message}`);

  if ((unresolvedCount ?? 0) >= COMPRESSION_THRESHOLD) {
    await compressMemories(project);
  }
}

// --- memory compression ----------------------------------------------------

async function compressMemories(
  project: string
): Promise<{ totalUnresolved: number; clustersCompressed: number }> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .eq("resolved", false);

  if (error) fail(`Failed to load memories for compression: ${error.message}`);

  const memories = data ?? [];
  if (memories.length < COMPRESSION_THRESHOLD) {
    return { totalUnresolved: memories.length, clustersCompressed: 0 };
  }

  const clusters = clusterMemories(memories);
  let clustersCompressed = 0;

  for (const cluster of clusters) {
    if (cluster.length < 3) continue;

    const summaryContent = buildSummaryContent(cluster);
    const { error: insertError } = await supabase
      .from("memories")
      .insert({ project, type: "discovery", content: summaryContent });

    if (insertError) fail(`Failed to insert summary memory: ${insertError.message}`);

    const idsToResolve = cluster.map((memory) => memory.id);
    const { error: resolveError } = await supabase
      .from("memories")
      .update({ resolved: true })
      .in("id", idsToResolve);

    if (resolveError) fail(`Failed to resolve compressed memories: ${resolveError.message}`);

    console.log(`Compressed ${cluster.length} memories into 1 summary`);
    clustersCompressed++;
  }

  console.log(`Compression complete. ${clustersCompressed} clusters compressed.`);
  return { totalUnresolved: memories.length, clustersCompressed };
}

// --- cm compress -------------------------------------------------------

async function cmdCompress(project: string) {
  const result = await compressMemories(project);
  if (result.totalUnresolved < COMPRESSION_THRESHOLD) {
    console.log(
      `Not enough memories to compress (need ${COMPRESSION_THRESHOLD}+, have ${result.totalUnresolved}).`
    );
  }
}

// --- cm fix --------------------------------------------------------------

async function cmdFix(project: string, problem: string, solution: string) {
  const { error } = await supabase
    .from("execution_log")
    .insert({ project, problem, solution, resolved: false });

  if (error) fail(`Failed to record fix: ${error.message}`);

  console.log(`Fix recorded for "${project}".`);
}

// --- cm analyze ------------------------------------------------------------

async function cmdAnalyze(project: string, path: string) {
  void project;
  const summary = analyzeCodebase(path);
  console.log(`Indexed ${summary.files_indexed} file(s):`);
  console.log(`  functions: ${summary.functions}`);
  console.log(`  classes:   ${summary.classes}`);
}

// --- cm search -------------------------------------------------------------

async function cmdSearch(project: string, query: string) {
  const { data: memories, error: memoriesError } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .ilike("content", `%${query}%`);

  if (memoriesError) fail(`Failed to search memories: ${memoriesError.message}`);

  const { data: fixes, error: fixesError } = await supabase
    .from("execution_log")
    .select("*")
    .eq("project", project)
    .or(`problem.ilike.%${query}%,solution.ilike.%${query}%`);

  if (fixesError) fail(`Failed to search past fixes: ${fixesError.message}`);

  const memoryResults = memories ?? [];
  const fixResults = fixes ?? [];

  if (memoryResults.length === 0 && fixResults.length === 0) {
    console.log("No results found");
    return;
  }

  console.log(`Memories (${memoryResults.length})`);
  console.log("-".repeat(11));
  if (memoryResults.length === 0) {
    console.log("No results found");
  } else {
    for (const memory of memoryResults) {
      console.log(`  [${memory.id}] (${memory.type}) ${memory.content}`);
    }
  }
  console.log("");

  console.log(`Past Fixes (${fixResults.length})`);
  console.log("-".repeat(14));
  if (fixResults.length === 0) {
    console.log("No results found");
  } else {
    for (const fix of fixResults) {
      console.log(`  Problem:  ${fix.problem}`);
      console.log(`  Solution: ${fix.solution}`);
      console.log("");
    }
  }
}

// --- cm resolve ------------------------------------------------------------

async function cmdResolve(project: string, memoryId: string) {
  const { error } = await supabase
    .from("memories")
    .update({ resolved: true })
    .eq("project", project)
    .eq("id", memoryId);

  if (error) fail(`Failed to resolve memory: ${error.message}`);

  console.log(`Resolved memory [${memoryId}]`);
}

// --- cm delete -------------------------------------------------------------

async function cmdDelete(project: string, memoryId: string) {
  const { error: linksError } = await supabase
    .from("memory_links")
    .delete()
    .or(`source_id.eq.${memoryId},target_id.eq.${memoryId}`);

  if (linksError) fail(`Failed to delete memory links: ${linksError.message}`);

  const { error } = await supabase
    .from("memories")
    .delete()
    .eq("project", project)
    .eq("id", memoryId);

  if (error) fail(`Failed to delete memory: ${error.message}`);

  console.log(`Deleted memory [${memoryId}]`);
}

// --- cm init -------------------------------------------------------------

// The hook logic lives in its own .mjs file (not directly in
// .git/hooks/post-commit) so its module type is unambiguous — an
// extensionless file run by git would otherwise have its CommonJS/ESM
// interpretation depend on the target repo's own package.json.
function buildHookLogicScript(project: string, cliPath: string): string {
  return `#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const PROJECT = ${JSON.stringify(project)};
const CLI_PATH = ${JSON.stringify(cliPath)};

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
savedItems.push(\`decision: \${commitMessage}\`);

const changedFiles = git(["diff-tree", "--no-commit-id", "-r", "--name-only", "HEAD"])
  .split("\\n")
  .filter(Boolean);

let diff = "";
try {
  diff = execFileSync("git", ["diff", "HEAD~1", "HEAD"], { encoding: "utf-8" });
} catch {
  diff = "";
}

const lines = diff.split("\\n");
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
      const content = \`new auth-related file: \${currentFile}\`;
      cmSave("discovery", content);
      savedItems.push(\`discovery: \${content}\`);
    }
    continue;
  }

  if (line.startsWith("-") && !line.startsWith("---")) {
    const codeLine = line.slice(1).trim();
    if (codeLine.startsWith("import") || codeLine.startsWith("require")) {
      const pathMatch = codeLine.match(/['"]([^'"]+)['"]/);
      const importPath = pathMatch ? pathMatch[1] : codeLine;
      const content = \`removed dependency: \${importPath}\`;
      cmSave("rejection", content);
      savedItems.push(\`rejection: \${content}\`);
    }
    continue;
  }

  if (line.startsWith("+") && !line.startsWith("+++") && currentFile) {
    const base = currentFile.split("/").pop() ?? currentFile;
    if (base === ".env" || base === ".env.example") {
      const codeLine = line.slice(1);
      const envMatch = codeLine.match(/([A-Z_]{3,})=/);
      if (envMatch) {
        const content = \`new env var required: \${envMatch[1]}\`;
        cmSave("constraint", content);
        savedItems.push(\`constraint: \${content}\`);
      }
    }
  }
}

console.log(\`coding-memory post-commit summary (\${changedFiles.length} file(s) changed):\`);
for (const item of savedItems) {
  console.log(\`  - \${item}\`);
}
`;
}

async function cmdInit(project: string, targetPath: string) {
  const resolvedPath = nodePath.resolve(targetPath);
  const gitDir = nodePath.join(resolvedPath, ".git");

  if (!nodeFs.existsSync(gitDir)) {
    console.error(`No git repo found at ${targetPath}`);
    process.exit(1);
  }

  const codingMemoryDir = nodePath.join(resolvedPath, ".coding-memory");
  nodeFs.mkdirSync(codingMemoryDir, { recursive: true });

  const hookLogicPath = nodePath.join(codingMemoryDir, "post-commit-hook.mjs");
  nodeFs.writeFileSync(hookLogicPath, buildHookLogicScript(project, CLI_PATH), "utf-8");

  const hooksDir = nodePath.join(gitDir, "hooks");
  nodeFs.mkdirSync(hooksDir, { recursive: true });

  const hookPath = nodePath.join(hooksDir, "post-commit");
  nodeFs.writeFileSync(hookPath, `#!/bin/sh\nexec node "${hookLogicPath}" "$@"\n`, "utf-8");
  nodeFs.chmodSync(hookPath, 0o755);

  console.log(`coding-memory hook installed for project ${project} at ${targetPath}`);
}

// --- cm context ------------------------------------------------------------

const CONTEXT_TYPE_ORDER: MemoryType[] = ["decision", "constraint", "rejection", "discovery"];
const CONTEXT_TOP_N = 5;

async function cmdContext(project: string, task: string) {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .eq("resolved", false);

  if (error) fail(`Failed to load memories: ${error.message}`);

  const memories = data ?? [];
  if (memories.length === 0) {
    console.log(`No memories found for "${project}".`);
    return;
  }

  const scoredMemories = memories
    .map((memory) => {
      const decayScore = computeDecayScore(new Date(memory.created_at), memory.access_count ?? 0);
      const relevanceScore = scoreMemoryRelevance(memory.content, task);
      return {
        ...memory,
        combined_score: relevanceScore * 0.6 + decayScore * 0.4,
      };
    })
    .sort((a, b) => b.combined_score - a.combined_score);

  const topMemories = scoredMemories.slice(0, CONTEXT_TOP_N);
  const budgetedMemories = applyContextBudget(topMemories, CONTEXT_BUDGET_TOKENS);
  const tokensUsed = budgetedMemories.reduce(
    (sum, memory) => sum + estimateTokens(memory.content),
    0
  );

  const lines: string[] = [`## Project Context: ${project}`, `### Task: ${task}`, ""];

  for (const type of CONTEXT_TYPE_ORDER) {
    const group = budgetedMemories.filter((memory) => memory.type === type);
    if (group.length === 0) continue;

    lines.push(`**${TYPE_LABELS[type]}**`);
    for (const memory of group) {
      lines.push(`- ${memory.content}`);
    }
    lines.push("");
  }

  lines.push(`*(${tokensUsed}/${CONTEXT_BUDGET_TOKENS} tokens used)*`);

  console.log(lines.join("\n"));
}

// --- main --------------------------------------------------------------

async function main() {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "start": {
      const [project] = args;
      if (!project) usage();
      await cmdStart(project);
      break;
    }
    case "save": {
      const [project, type, ...rest] = args;
      if (!project || !type || rest.length === 0) usage();
      await cmdSave(project, type, rest.join(" "));
      break;
    }
    case "fix": {
      const [project, problem, solution] = args;
      if (!project || !problem || !solution) usage();
      await cmdFix(project, problem, solution);
      break;
    }
    case "analyze": {
      const [project, path] = args;
      if (!project || !path) usage();
      await cmdAnalyze(project, path);
      break;
    }
    case "search": {
      const [project, ...rest] = args;
      if (!project || rest.length === 0) usage();
      await cmdSearch(project, rest.join(" "));
      break;
    }
    case "resolve": {
      const [project, memoryId] = args;
      if (!project || !memoryId) usage();
      await cmdResolve(project, memoryId);
      break;
    }
    case "delete": {
      const [project, memoryId] = args;
      if (!project || !memoryId) usage();
      await cmdDelete(project, memoryId);
      break;
    }
    case "compress": {
      const [project] = args;
      if (!project) usage();
      await cmdCompress(project);
      break;
    }
    case "init": {
      const [project, targetPath] = args;
      if (!project || !targetPath) usage();
      await cmdInit(project, targetPath);
      break;
    }
    case "context": {
      const [project, ...rest] = args;
      if (!project || rest.length === 0) usage();
      await cmdContext(project, rest.join(" "));
      break;
    }
    case "help": {
      cmdHelp();
      break;
    }
    default:
      usage();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
