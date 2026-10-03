#!/usr/bin/env tsx
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { analyzeCodebase } from "./ast-index.js";
import { getDeviceId } from "./device.js";
import {
  applyContextBudget,
  buildSummaryContent,
  clusterMemories,
  computeDecayScore,
  computeMemoryLinks,
  decideSaveAction,
  estimateTokens,
  indicatesFailedApproach,
  isAuthRelatedFile,
  isCodeFile,
  isQualityMessage,
  scoreMemoryRelevance,
} from "./scoring.js";
import { supabase } from "./storage.js";

const CONTEXT_BUDGET_TOKENS = 2000;
const COMPRESSION_THRESHOLD = 20;
const CLI_PATH = fileURLToPath(import.meta.url);
// The hook must always shell out to the compiled CLI, never `tsx src/cli.ts`
// directly — tsx's esbuild transform fails when invoked from inside a git
// hook's stripped-down shell environment.
const DIST_CLI_PATH = nodePath.join(nodePath.dirname(CLI_PATH), "..", "dist", "cli.js");
const DIST_INDEX_PATH = nodePath.join(nodePath.dirname(CLI_PATH), "..", "dist", "index.js");

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
  cm start [project]
  cm save [project] <type> <content> [--force]  (type: decision|rejection|constraint|discovery)
  cm fix [project] <problem> <solution>
  cm analyze [project] <path>
  cm search [--project <name>] <query>
  cm resolve [project] <memory-id>
  cm delete [project] <memory-id>
  cm compress [project]
  cm init <project> <path>
  cm context [--project <name>] <task>
  cm session-end [project] [--summary <text>] [--errors <a,b>] [--files <a,b>] [--approaches <a,b>]
  cm help

  [project] is optional if a .stackmem file exists in the current
  directory (written by 'cm init'). Otherwise it must be given explicitly.
  search/context take --project instead of a positional project, since a
  bare query/task can't otherwise be told apart from a project name.`);
  process.exit(1);
}

function cmdHelp() {
  console.log(`cm — coding memory CLI

  [project] is optional everywhere below if a .stackmem file exists in
  the current directory (written by 'cm init'). Otherwise pass it explicitly.

  cm start [project]
      Load all unresolved memories for a project, sorted by decay
      score and capped at a 2000 token context budget, grouped by
      type (decisions, constraints, discoveries, rejections), with
      linked memory ids shown under each entry.

  cm save [project] <type> <content> [--force]
      Save a new memory. <type> is one of: decision, rejection,
      constraint, discovery. Automatically links to related existing
      memories. If the new memory contradicts an existing one, prompts
      to keep the old memory or replace it — pass --force to skip the
      prompt and always replace.

  cm fix [project] <problem> <solution>
      Record a problem and its solution for future reference.

  cm analyze [project] <path>
      Build an AST index (files, functions, classes) for the codebase
      at <path>.

  cm search [--project <name>] <query>
      Search saved memories and past fixes for a project matching
      <query>. The whole query is always the full remaining text — use
      --project to search a project other than the one in .stackmem.

  cm resolve [project] <memory-id>
      Mark a memory as resolved.

  cm delete [project] <memory-id>
      Delete a memory and any memory_links referencing it.

  cm compress [project]
      Cluster related unresolved memories (needs 20+) and collapse
      clusters of 3 or more into a single summary memory.

  cm init <project> <path>
      Install a git post-commit hook in the repo at <path>, register
      the stackmem MCP server with Claude Code, write a CLAUDE.md and
      .stackmem file, and seed initial memories from the project scan.

  cm context [--project <name>] <task>
      Return only the top 5 memories most relevant to a specific
      task, ranked by a blend of task relevance and decay score,
      as a markdown block capped at a 2000 token budget. Use
      --project to target a project other than the one in .stackmem.

  cm session-end [project] [--summary <text>] [--errors <a,b>] [--files <a,b>] [--approaches <a,b>]
      Capture what happened in a session and extract memories: each
      error becomes an unsolved execution_log entry, each approach
      containing "failed", "didn't work", "reverted", or "switched
      away" becomes a rejection, a summary that passes the quality
      filter becomes a decision, auth-related files become a
      discovery, and any .ts/.js file triggers an AST re-index.
      Accepts the same fields as JSON on stdin instead of flags
      (project, summary, errors_encountered, files_touched,
      approaches_tried) when stdin is piped rather than a terminal.

  cm help
      Show this help message.`);
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

// --- optional project resolution ------------------------------------------

const STACKMEM_FILE = ".stackmem";

function readProjectFromFile(): string | null {
  const stackmemPath = nodePath.join(process.cwd(), STACKMEM_FILE);
  if (!nodeFs.existsSync(stackmemPath)) return null;
  const content = nodeFs.readFileSync(stackmemPath, "utf-8").trim();
  return content.length > 0 ? content : null;
}

// Catches the common habit-slip of typing `cm fix . "problem" "solution"` by
// muscle memory from `cm init <project> .` — "." (or "..", or anything
// path-shaped) is never a real project name, so an explicit arg this shape
// almost certainly means the caller meant to omit the project entirely.
function looksLikeAPath(value: string): boolean {
  return value === "." || value === ".." || value.includes("/") || value.includes("\\");
}

function requireProject(explicit: string | null): string {
  if (explicit && looksLikeAPath(explicit)) {
    console.error(
      `Warning: '${explicit}' is not a valid project name — reading from .stackmem instead.`
    );
    explicit = null;
  }

  if (explicit) return explicit;

  const fromFile = readProjectFromFile();
  if (fromFile) return fromFile;

  console.error(
    "No project specified and no .stackmem file found. Run 'cm init <project> .' first or pass a project name."
  );
  process.exit(1);
}

// For commands whose non-project args have a fixed count: if exactly that
// many args are given, project was omitted; if one more, the first is the
// project. Anything else is a usage error.
function splitOptionalProject(
  args: string[],
  fixedArgCount: number
): { project: string | null; rest: string[] } | null {
  if (args.length === fixedArgCount) return { project: null, rest: args };
  if (args.length === fixedArgCount + 1) return { project: args[0], rest: args.slice(1) };
  return null;
}

// For commands whose remaining arg is free-form text (a query or task),
// arg count can't disambiguate an omitted project from a multi-word query —
// "cm search bug fix" is ambiguous by count alone. Use .stackmem's presence
// instead: if it exists, nothing is positionally a project.
// Arg count can't disambiguate an omitted project from a multi-word query —
// "cm search bug fix" is ambiguous by count alone. Treating .stackmem's mere
// presence as "project omitted" (the previous approach) was worse: it
// silently swallowed an explicit project into the query text whenever a
// .stackmem file happened to exist in cwd, so "cm search otherproj auth bug"
// would search project X (from .stackmem) for the literal text "otherproj
// auth bug" with no error. Positional args are now always the full
// query/task; an explicit override uses --project <name> instead, which is
// never ambiguous and is never silently absorbed.
function splitProjectFromVariadic(args: string[]): { project: string | null; rest: string[] } {
  const flagIndex = args.indexOf("--project");
  if (flagIndex !== -1 && args[flagIndex + 1] !== undefined) {
    const project = args[flagIndex + 1];
    const rest = [...args.slice(0, flagIndex), ...args.slice(flagIndex + 2)];
    return { project, rest };
  }
  return { project: null, rest: args };
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

// Prompts on stdin before superseding — cm save runs interactively, unlike
// the MCP save_memory tool, which must supersede automatically since it has
// no user attached to ask.
async function confirmSupersede(oldId: string, newContent: string): Promise<boolean> {
  const { data: oldMemory, error } = await supabase
    .from("memories")
    .select("content")
    .eq("id", oldId)
    .single();

  if (error || !oldMemory) fail(`Failed to load superseded memory: ${error?.message ?? "not found"}`);

  console.log(`Conflict detected:\n  Old: ${oldMemory.content}\n  New: ${newContent}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Keep old or replace? (k/r): ")).trim().toLowerCase();
  rl.close();

  if (answer === "k") {
    console.log("Kept original memory.");
    return false;
  }
  if (answer === "r") {
    return true;
  }
  console.log("Invalid input — kept original memory.");
  return false;
}

async function cmdSave(project: string, type: string, content: string, force = false) {
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

  if (decision.action === "superseded" && !force) {
    const shouldSupersede = await confirmSupersede(decision.oldId, content);
    if (!shouldSupersede) return;
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
    .insert({ project, type, content, device_id: getDeviceId() })
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
    console.log(`Replaced with new memory [${newMemoryId}].`);
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
      .insert({ project, type: "discovery", content: summaryContent, device_id: getDeviceId() });

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
    .insert({ project, problem, solution, resolved: false, device_id: getDeviceId() });

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
function buildHookLogicScript(cliPath: string): string {
  return `#!/usr/bin/env node
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

const CLI_PATH = ${JSON.stringify(cliPath)};

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
    /\\.config\\.(ts|js)$/.test(base) ||
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

const SEMVER_RE = /^\\d+\\.\\d+\\.\\d+$/;

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

  const stripped = trimmed.replace(/\\s/g, "");
  if (stripped.length > 0 && new Set(stripped).size === 1) return false;

  const lowerTrimmed = trimmed.toLowerCase();
  if (LOW_QUALITY_PREFIXES.includes(lowerTrimmed)) return false;

  const firstWord = (lowerTrimmed.match(/^[a-z0-9]+/) || [""])[0];
  if (LOW_QUALITY_PREFIXES.includes(firstWord)) return false;

  return true;
}

const savedItems = [];

const commitMessage = git(["log", "-1", "--pretty=%B"]);

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
  .split("\\n")
  .filter(Boolean);

let diff = "";
if (!isFirstCommit) {
  try {
    diff = execFileSync("git", ["diff", "HEAD~1", "HEAD"], { encoding: "utf-8" });
  } catch {
    diff = "";
  }
}

const lines = diff.split("\\n");
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
        const content = \`new auth-related file: \${currentFile}\`;
        cmSave("discovery", content);
        savedItems.push(\`discovery: \${content}\`);
      }
      if (isConfigFile(currentFile)) {
        const content = \`new config: \${currentFile}\`;
        cmSave("constraint", content);
        savedItems.push(\`constraint: \${content}\`);
      }
      if (isSchemaFile(currentFile)) {
        const content = \`schema change: \${currentFile}\`;
        cmSave("discovery", content);
        savedItems.push(\`discovery: \${content}\`);
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
    if (/"(dependencies|devDependencies)"\\s*:\\s*\\{/.test(rawLine)) {
      inDependenciesSection = true;
    } else if (inDependenciesSection && /^\\s*\\}/.test(rawLine)) {
      inDependenciesSection = false;
    }
  }

  if (line.startsWith("-") && !line.startsWith("---")) {
    const codeLine = line.slice(1).trim();

    const importMatch = line.match(
      /^-\\s*(import\\s+.*\\s+from\\s+['"]([^'"]+)['"]|import\\s+['"]([^'"]+)['"])/
    );
    const requireMatch = line.match(
      /^-\\s*(?:const|let|var)\\s+\\S+\\s*=\\s*require\\(['"]([^'"]+)['"]\\)/
    );
    const removedModulePath = importMatch
      ? importMatch[2] || importMatch[3]
      : requireMatch
        ? requireMatch[1]
        : null;

    if (removedModulePath) {
      const content = \`removed dependency: \${removedModulePath}\`;
      cmSave("rejection", content);
      savedItems.push(\`rejection: \${content}\`);
    }

    if (isPackageJson && inDependenciesSection) {
      const pkgMatch = codeLine.match(/"([a-z][\\w-]+)"\\s*:/);
      if (pkgMatch && pkgMatch[1] !== "dependencies" && pkgMatch[1] !== "devDependencies") {
        const content = \`removed dependency: \${pkgMatch[1]}\`;
        cmSave("rejection", content);
        savedItems.push(\`rejection: \${content}\`);
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
          const content = \`new env var required: \${envMatch[1]}\`;
          cmSave("constraint", content);
          savedItems.push(\`constraint: \${content}\`);
        }
      }
    }

    if (isPackageJson && inDependenciesSection) {
      const pkgMatch = codeLine.match(/"([a-z][\\w-]+)"\\s*:/);
      if (pkgMatch && pkgMatch[1] !== "dependencies" && pkgMatch[1] !== "devDependencies") {
        const content = \`added dependency: \${pkgMatch[1]}\`;
        cmSave("decision", content);
        savedItems.push(\`decision: \${content}\`);
      }
    }

    if (currentFile && isSchemaFile(currentFile) && /CREATE TABLE|ALTER TABLE|DROP TABLE/i.test(codeLine)) {
      const truncated = codeLine.trim().slice(0, 80);
      const content = \`database change: \${truncated}\`;
      cmSave("discovery", content);
      savedItems.push(\`discovery: \${content}\`);
    }

    if (/TODO:|FIXME:|HACK:|XXX:/.test(codeLine)) {
      const truncated = codeLine.trim().slice(0, 100);
      const content = \`open issue from commit: \${truncated}\`;
      cmSave("discovery", content);
      savedItems.push(\`discovery: \${content}\`);
    }
  }
}

// Saved last, after every diff-detected memory, and only if it clears the
// quality filter — diff analysis always runs regardless of commit message.
if (isQualityCommitMessage(commitMessage)) {
  const trimmedMessage = commitMessage.trim();
  cmSave("decision", trimmedMessage);
  savedItems.push(\`decision: \${trimmedMessage}\`);
}

console.log(\`coding-memory post-commit summary (\${changedFiles.length} file(s) changed):\`);
for (const item of savedItems) {
  console.log(\`  - \${item}\`);
}
`;
}

function registerMcpServer(distIndexPath: string): void {
  const claudeConfigPath = nodePath.join(nodeOs.homedir(), ".claude.json");

  let config: { mcpServers?: Record<string, unknown> } = {};
  if (nodeFs.existsSync(claudeConfigPath)) {
    try {
      config = JSON.parse(nodeFs.readFileSync(claudeConfigPath, "utf-8"));
    } catch {
      config = {};
    }
  }

  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }

  if (config.mcpServers.stackmem) {
    return;
  }

  config.mcpServers.stackmem = {
    command: "node",
    args: [distIndexPath],
  };

  nodeFs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), "utf-8");
  console.log("stackmem MCP server registered with Claude Code.");
}

function writeClaudeMd(project: string, resolvedPath: string): void {
  const claudeMdPath = nodePath.join(resolvedPath, "CLAUDE.md");

  if (nodeFs.existsSync(claudeMdPath)) {
    console.log("CLAUDE.md already exists — skipping.");
    return;
  }

  const content = `# stackmem

At the start of every session, the stackmem MCP server will automatically load memories for this project. The project name is "${project}".

If the MCP server is not connected, run:
cm start ${project}
and paste the output here before starting work.

When you make a decision, discover a constraint, reject an approach, or make a discovery during this session, save it with:
cm save ${project} <type> "<content>"
`;

  nodeFs.writeFileSync(claudeMdPath, content, "utf-8");
  console.log("CLAUDE.md written.");
}

function writeProjectFile(project: string, resolvedPath: string): void {
  const stackmemPath = nodePath.join(resolvedPath, STACKMEM_FILE);
  nodeFs.writeFileSync(stackmemPath, `${project}\n`, "utf-8");
}

// Scans the freshly-initialized project for a few cheap, high-signal facts
// and saves them as memories directly (bypassing cmdSave's duplicate/conflict
// prompt — there's nothing to conflict with yet, and init must stay
// non-interactive). Returns how many memories were actually saved.
async function seedMemories(project: string, resolvedPath: string): Promise<number> {
  let seededCount = 0;

  const packageJsonPath = nodePath.join(resolvedPath, "package.json");
  if (nodeFs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(nodeFs.readFileSync(packageJsonPath, "utf-8"));
      const depNames = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ];
      if (depNames.length > 0) {
        const { error } = await supabase.from("memories").insert({
          project,
          type: "discovery",
          content: `tech stack: ${depNames.join(", ")}`,
          device_id: getDeviceId(),
        });
        if (!error) seededCount++;
      }
    } catch {
      // Malformed package.json — skip the tech-stack memory.
    }
  }

  const envExamplePath = nodePath.join(resolvedPath, ".env.example");
  if (nodeFs.existsSync(envExamplePath)) {
    const varNames = nodeFs
      .readFileSync(envExamplePath, "utf-8")
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => line.split("=")[0]);

    if (varNames.length > 0) {
      const { error } = await supabase.from("memories").insert({
        project,
        type: "constraint",
        content: `required env vars: ${varNames.join(", ")}`,
        device_id: getDeviceId(),
      });
      if (!error) seededCount++;
    }
  }

  analyzeCodebase(resolvedPath);

  return seededCount;
}

// Smoke-tests the same anon-key + device-header path session_start/cmdStart
// use, without pulling in all of cmdStart's scoring/formatting logic.
async function verifyBackendConnection(project: string): Promise<boolean> {
  const { error } = await supabase
    .from("memories")
    .select("id", { count: "exact", head: true })
    .eq("project", project);

  return !error;
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
  nodeFs.writeFileSync(hookLogicPath, buildHookLogicScript(DIST_CLI_PATH), "utf-8");

  const hooksDir = nodePath.join(gitDir, "hooks");
  nodeFs.mkdirSync(hooksDir, { recursive: true });

  const hookPath = nodePath.join(hooksDir, "post-commit");
  nodeFs.writeFileSync(hookPath, `#!/bin/sh\nexec node "${hookLogicPath}" "$@"\n`, "utf-8");
  nodeFs.chmodSync(hookPath, 0o755);

  console.log(`coding-memory hook installed for project ${project} at ${targetPath}`);

  registerMcpServer(DIST_INDEX_PATH);
  writeClaudeMd(project, resolvedPath);

  const seededCount = await seedMemories(project, resolvedPath);
  console.log(`Seeded ${seededCount} initial memories from project scan.`);

  const backendOk = await verifyBackendConnection(project);

  console.log("");
  console.log("✓ Git hook installed");
  console.log("✓ MCP server registered");
  console.log("✓ CLAUDE.md written");
  console.log(`✓ Seeded ${seededCount} memories from project scan`);
  if (backendOk) {
    console.log("✓ Backend connection verified");
    console.log("");
    console.log(
      `stackmem is live. Open Claude Code and ask "what do you know about this project?" to verify.`
    );
  } else {
    console.log("✗ Backend connection failed — run 'cm doctor' (once we build it)");
  }

  // Written last and deliberately: if a commit (and hence the post-commit
  // hook) fires anywhere during init, it must still see whatever project
  // .stackmem pointed to before this run, not the one being initialized now.
  writeProjectFile(project, resolvedPath);
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

// --- cm session-end --------------------------------------------------------

interface SessionEndInput {
  project: string | null;
  summary?: string;
  errors: string[];
  files: string[];
  approaches: string[];
}

function splitCommaList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Flags only — stdin JSON is handled separately in cmdSessionEndEntry, since
// it carries its own full shape (arrays, not comma-joined strings).
function parseSessionEndFlags(args: string[]): SessionEndInput {
  let project: string | null = null;
  let summary: string | undefined;
  let errors: string[] = [];
  let files: string[] = [];
  let approaches: string[] = [];

  let i = 0;
  if (args[i] && !args[i].startsWith("--")) {
    project = args[i];
    i++;
  }

  for (; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--summary") {
      summary = value;
      i++;
    } else if (flag === "--errors") {
      errors = splitCommaList(value);
      i++;
    } else if (flag === "--files") {
      files = splitCommaList(value);
      i++;
    } else if (flag === "--approaches") {
      approaches = splitCommaList(value);
      i++;
    }
  }

  return { project, summary, errors, files, approaches };
}

async function readStdinJson(): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

async function cmdSessionEnd(project: string, input: Omit<SessionEndInput, "project">) {
  let memoriesSaved = 0;
  let errorsLogged = 0;

  for (const problem of input.errors) {
    const { error } = await supabase.from("execution_log").insert({
      project,
      problem,
      solution: null,
      resolved: false,
      device_id: getDeviceId(),
    });
    if (!error) errorsLogged++;
  }

  for (const approach of input.approaches) {
    if (!indicatesFailedApproach(approach)) continue;
    const { error } = await supabase.from("memories").insert({
      project,
      type: "rejection",
      content: approach,
      device_id: getDeviceId(),
    });
    if (!error) memoriesSaved++;
  }

  if (input.summary && isQualityMessage(input.summary)) {
    const { error } = await supabase.from("memories").insert({
      project,
      type: "decision",
      content: input.summary.trim(),
      device_id: getDeviceId(),
    });
    if (!error) memoriesSaved++;
  }

  const authFiles = input.files.filter(isAuthRelatedFile);
  if (authFiles.length > 0) {
    const { error } = await supabase.from("memories").insert({
      project,
      type: "discovery",
      content: `session touched auth files: ${authFiles.join(", ")}`,
      device_id: getDeviceId(),
    });
    if (!error) memoriesSaved++;
  }

  if (input.files.some(isCodeFile)) {
    analyzeCodebase(process.cwd());
  }

  console.log(`Session captured. ${memoriesSaved} memories saved.`);
  if (errorsLogged > 0) {
    console.log(`${errorsLogged} error(s) logged to execution_log.`);
  }
}

// Dispatches to JSON-from-stdin or flag parsing depending on how the
// command was invoked — piped input (e.g. from a script) uses JSON; an
// interactive terminal with no piped stdin uses flags.
async function cmdSessionEndEntry(args: string[]) {
  let input: SessionEndInput;

  if (!process.stdin.isTTY) {
    const json = await readStdinJson();
    if (json) {
      input = {
        project: typeof json.project === "string" ? json.project : null,
        summary: typeof json.summary === "string" ? json.summary : undefined,
        errors: Array.isArray(json.errors_encountered) ? json.errors_encountered : [],
        files: Array.isArray(json.files_touched) ? json.files_touched : [],
        approaches: Array.isArray(json.approaches_tried) ? json.approaches_tried : [],
      };
    } else {
      input = parseSessionEndFlags(args);
    }
  } else {
    input = parseSessionEndFlags(args);
  }

  const project = requireProject(input.project);
  await cmdSessionEnd(project, {
    summary: input.summary,
    errors: input.errors,
    files: input.files,
    approaches: input.approaches,
  });
}

// --- main --------------------------------------------------------------

async function main() {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "start": {
      const split = splitOptionalProject(args, 0);
      if (!split) usage();
      const project = requireProject(split.project);
      await cmdStart(project);
      break;
    }
    case "save": {
      const forceIndex = args.indexOf("--force");
      const force = forceIndex !== -1;
      const positional = force
        ? [...args.slice(0, forceIndex), ...args.slice(forceIndex + 1)]
        : args;

      let explicitProject: string | null;
      let type: string | undefined;
      let rest: string[];
      if (MEMORY_TYPES.includes(positional[0] as MemoryType)) {
        explicitProject = null;
        [type, ...rest] = positional;
      } else {
        explicitProject = positional[0] ?? null;
        [, type, ...rest] = positional;
      }

      if (!type || rest.length === 0) usage();
      const project = requireProject(explicitProject);
      await cmdSave(project, type, rest.join(" "), force);
      break;
    }
    case "fix": {
      const split = splitOptionalProject(args, 2);
      if (!split) usage();
      const project = requireProject(split.project);
      const [problem, solution] = split.rest;
      await cmdFix(project, problem, solution);
      break;
    }
    case "analyze": {
      const split = splitOptionalProject(args, 1);
      if (!split) usage();
      const project = requireProject(split.project);
      const [path] = split.rest;
      await cmdAnalyze(project, path);
      break;
    }
    case "search": {
      const split = splitProjectFromVariadic(args);
      const project = requireProject(split.project);
      if (split.rest.length === 0) usage();
      await cmdSearch(project, split.rest.join(" "));
      break;
    }
    case "resolve": {
      const split = splitOptionalProject(args, 1);
      if (!split) usage();
      const project = requireProject(split.project);
      const [memoryId] = split.rest;
      await cmdResolve(project, memoryId);
      break;
    }
    case "delete": {
      const split = splitOptionalProject(args, 1);
      if (!split) usage();
      const project = requireProject(split.project);
      const [memoryId] = split.rest;
      await cmdDelete(project, memoryId);
      break;
    }
    case "compress": {
      const split = splitOptionalProject(args, 0);
      if (!split) usage();
      const project = requireProject(split.project);
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
      const split = splitProjectFromVariadic(args);
      const project = requireProject(split.project);
      if (split.rest.length === 0) usage();
      await cmdContext(project, split.rest.join(" "));
      break;
    }
    case "session-end": {
      await cmdSessionEndEntry(args);
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
