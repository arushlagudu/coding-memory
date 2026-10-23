#!/usr/bin/env tsx
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  extractEntities,
  indicatesFailedApproach,
  isAuthRelatedFile,
  isCodeFile,
  isQualityMessage,
  redactSecrets,
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

// Written into every file/hook stackmem manages, so `cm uninstall` (and the
// hook installer's chaining check) can tell "ours, safe to remove/replace"
// apart from a user's own pre-existing file/hook with the same name.
const STACKMEM_HOOK_MARKER = "# stackmem-managed";
const CLAUDE_MD_MARKER = "the stackmem MCP server will automatically load memories for this project";
const RULES_FILE_MARKER = "# stackmem — project memory (auto-updated)";
const HOOK_BACKUP_FILENAME = "post-commit.pre-stackmem";

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
  cm inspect [project] <memory-id>
  cm compress [project]
  cm init <project> <path>
  cm uninstall [project] [path]
  cm sync
  cm context [--project <name>] <task>
  cm session-end [project] [--summary <text>] [--errors <a,b>] [--files <a,b>] [--approaches <a,b>]
  cm doctor [--fix]
  cm undo [project]
  cm export [filename]
  cm import [project] <filename>
  cm help

  [project] is optional if a .stackmem file exists in the current
  directory (written by 'cm init'). Otherwise it must be given explicitly.
  search/context take --project instead of a positional project, since a
  bare query/task can't otherwise be told apart from a project name.`);
  process.exit(1);
}

function cmdHelp() {
  console.log(`cm — coding memory CLI

  Works with Claude Code, Cursor, and Windsurf — 'cm init' writes the
  CLAUDE.md, .cursorrules, and .windsurfrules files each tool reads.

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

  cm inspect [project] <memory-id>
      Show a rich view of a single memory: type, content, created
      date, access count, decay score, and resolved status, plus
      every linked memory (in either link direction) with its link
      score, and any execution_log fixes whose problem or solution
      shares a key entity with the memory's content.

  cm compress [project]
      Cluster related unresolved memories (needs 20+) and collapse
      clusters of 3 or more into a single summary memory.

  cm init <project> <path>
      Install a git post-commit hook in the repo at <path>, register
      the stackmem MCP server with Claude Code, write a CLAUDE.md,
      .cursorrules, .windsurfrules, and .stackmem file, and seed
      initial memories from the project scan. .cursorrules and
      .windsurfrules are pre-filled with the project's current
      memories (for Cursor and Windsurf) and skipped if they already
      exist. The post-commit hook keeps them fresh afterward by
      running 'cm sync' on every commit.

  cm uninstall [project] [path]
      Remove everything 'cm init' set up at <path> (defaults to the
      current directory): the git post-commit hook (restoring whatever
      hook it chained after, if any), .coding-memory/post-commit-hook.mjs,
      .coding-memory/ast-index.db and the .coding-memory/ directory
      itself if left empty, the .stackmem file, and CLAUDE.md /
      .cursorrules / .windsurfrules — the last three only if they still
      carry the stackmem marker, so hand-edited files are left alone.
      Also removes the stackmem entry from ~/.claude.json's mcpServers.
      [project] defaults to the .stackmem file at <path> if omitted.

  cm sync
      Regenerate .cursorrules and .windsurfrules from the project's
      current unresolved memories (decay-ranked, capped at a 2000
      token budget) and its 5 most recent open execution_log fixes,
      overwriting both files. Project is read from .stackmem.

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

  cm doctor [--fix]
      Check every integration point in the current directory — backend
      connection, MCP registration, .stackmem, git hook, and memory
      count — and report what's working and what's broken. With --fix,
      attempt a repair after each failing check: re-register the MCP
      server, or re-install the git hook. A failed backend connection,
      a missing .stackmem file, or no memories yet can't be auto-fixed
      (they need a working network, 'cm init', or a commit respectively)
      — those print guidance instead. Reports "Fixed: <item>" or
      "Could not auto-fix: <item>" for each failing check.

  cm undo [project]
      Delete the most recently saved unresolved memory (and any
      memory_links referencing it) for a project.

  cm export [filename]
      Export all unresolved memories, execution_log entries, and
      memory_links for a project to a JSON file. Defaults to
      <project>-memories.json.

  cm import [project] <filename>
      Import memories and execution_log entries from a JSON file
      produced by 'cm export'. Inserted under the current device_id
      and project; memory_links are skipped and get rebuilt by
      semantic linking the next time cm save runs.

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
    console.log("");
    console.log("Tip: run 'cm init' to seed tech stack memories from your project files.");
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
  let tokensUsed = budgetedMemories.reduce(
    (sum, memory) => sum + estimateTokens(memory.content),
    0
  );

  const { data: fixData, error: fixError } = await supabase
    .from("execution_log")
    .select("*")
    .eq("project", project)
    .eq("resolved", false)
    .order("created_at", { ascending: false })
    .limit(5);

  if (fixError) fail(`Failed to load execution log: ${fixError.message}`);

  // Fixes share the same 2000-token budget as memories, which already
  // consumed their portion above — fixes only get whatever room is left.
  const budgetedFixes: { problem: string; solution: string | null }[] = [];
  for (const fix of fixData ?? []) {
    const tokens = estimateTokens(`${fix.problem} ${fix.solution ?? ""}`);
    if (tokensUsed + tokens > CONTEXT_BUDGET_TOKENS) break;
    budgetedFixes.push(fix);
    tokensUsed += tokens;
  }

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

  if (budgetedFixes.length > 0) {
    console.log(`Past Fixes (${budgetedFixes.length})`);
    console.log("-".repeat(14));
    for (const fix of budgetedFixes) {
      console.log(`  Problem: ${fix.problem}`);
      console.log(`  Solution: ${fix.solution ?? "(pending)"}`);
      console.log("");
    }
  }

  console.log(`Context budget: ${tokensUsed}/${CONTEXT_BUDGET_TOKENS} tokens used`);
  if (omittedCount > 0) {
    console.log(`${omittedCount} memories omitted (budget exceeded)`);
  }

  const hasTechStackMemory = memories.some((m) => /^tech stack:/i.test(m.content));
  if (!hasTechStackMemory) {
    console.log("");
    console.log("Tip: run 'cm init' to seed tech stack memories from your project files.");
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
    fail(`Invalid memory type '${type}'. Valid types: decision, constraint, discovery, rejection.`);
  }

  if (content.length > 500) {
    fail(
      `Memory content too long (${content.length} chars). Keep memories under 500 characters — they should be concise facts, not paragraphs.`
    );
  }

  // Redacted before any further use — comparisons, prompts, and storage all
  // see the scrubbed text, so a secret never round-trips through a console
  // prompt (confirmSupersede) or ends up persisted.
  content = redactSecrets(content);

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
  if (problem.trim().length === 0 || solution.trim().length === 0) {
    fail("Problem and solution cannot be empty.");
  }

  problem = redactSecrets(problem);
  solution = redactSecrets(solution);

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
  const { data, error } = await supabase
    .from("memories")
    .update({ resolved: true })
    .eq("project", project)
    .eq("id", memoryId)
    .select("id");

  if (error) fail(`Failed to resolve memory: ${error.message}`);

  if (!data || data.length === 0) {
    console.log(`No memory found with ID [${memoryId}]`);
    return;
  }

  console.log(`Resolved memory [${memoryId}]`);
}

// --- cm delete -------------------------------------------------------------

async function cmdDelete(project: string, memoryId: string) {
  const { error: linksError } = await supabase
    .from("memory_links")
    .delete()
    .or(`source_id.eq.${memoryId},target_id.eq.${memoryId}`);

  if (linksError) fail(`Failed to delete memory links: ${linksError.message}`);

  const { data, error } = await supabase
    .from("memories")
    .delete()
    .eq("project", project)
    .eq("id", memoryId)
    .select("id");

  if (error) fail(`Failed to delete memory: ${error.message}`);

  if (!data || data.length === 0) {
    console.log(`No memory found with ID [${memoryId}]`);
    return;
  }

  console.log(`Deleted memory [${memoryId}]`);
}

// --- cm inspect ------------------------------------------------------------

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

async function cmdInspect(project: string, memoryId: string) {
  const { data: memory, error } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .eq("id", memoryId)
    .single();

  if (error || !memory) fail(`Memory [${memoryId}] not found for "${project}".`);

  const decayScore = computeDecayScore(new Date(memory.created_at), memory.access_count ?? 0);

  const { data: links, error: linksError } = await supabase
    .from("memory_links")
    .select("source_id, target_id, score")
    .or(`source_id.eq.${memoryId},target_id.eq.${memoryId}`);

  if (linksError) fail(`Failed to load memory links: ${linksError.message}`);

  const linkedEntries = (links ?? []).map((link) => ({
    linkedId: link.source_id === memoryId ? link.target_id : link.source_id,
    score: link.score,
  }));

  let linkedMemories: Array<{
    id: string;
    type: string;
    content: string;
    created_at: string;
    score: number;
  }> = [];

  if (linkedEntries.length > 0) {
    const linkedIds = linkedEntries.map((entry) => entry.linkedId);
    const { data: linkedRows, error: linkedError } = await supabase
      .from("memories")
      .select("id, type, content, created_at")
      .in("id", linkedIds);

    if (linkedError) fail(`Failed to load linked memories: ${linkedError.message}`);

    const scoreById = new Map(linkedEntries.map((entry) => [entry.linkedId, entry.score]));
    linkedMemories = (linkedRows ?? [])
      .map((row) => ({ ...row, score: scoreById.get(row.id) ?? 0 }))
      .sort((a, b) => b.score - a.score);
  }

  const entities = extractEntities(memory.content);
  const { data: fixes, error: fixesError } = await supabase
    .from("execution_log")
    .select("problem, solution")
    .eq("project", project);

  if (fixesError) fail(`Failed to load execution log: ${fixesError.message}`);

  const relatedFixes = (fixes ?? []).filter((fix) => {
    const fixEntities = extractEntities(`${fix.problem} ${fix.solution}`);
    for (const entity of entities) {
      if (fixEntities.has(entity)) return true;
    }
    return false;
  });

  const divider = "─".repeat(40);
  console.log(divider);
  console.log(
    `${memory.type.toUpperCase()} · accessed ${memory.access_count ?? 0}x · decay ${decayScore.toFixed(2)}`
  );
  console.log(divider);
  console.log(memory.content);
  console.log("");
  console.log(`Created: ${formatDate(memory.created_at)}`);
  console.log(`Status:  ${memory.resolved ? "resolved" : "unresolved"}`);
  console.log("");

  console.log(`LINKED MEMORIES (${linkedMemories.length})`);
  for (const linked of linkedMemories) {
    console.log(`  └─ [score: ${linked.score.toFixed(2)}] ${linked.type.toUpperCase()}`);
    console.log(`     ${linked.content}`);
    console.log(`     ${formatDate(linked.created_at)}`);
    console.log("");
  }

  if (relatedFixes.length > 0) {
    console.log(`RELATED FIXES (${relatedFixes.length})`);
    for (const fix of relatedFixes) {
      console.log(`  └─ FIX: ${fix.problem} → ${fix.solution}`);
    }
  }
}

// --- cm init -------------------------------------------------------------

// The hook logic lives in its own .mjs file (not directly in
// .git/hooks/post-commit) so its module type is unambiguous — an
// extensionless file run by git would otherwise have its CommonJS/ESM
// interpretation depend on the target repo's own package.json.
function buildHookLogicScript(cliPath: string): string {
  return `#!/usr/bin/env node
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

const CLI_PATH = ${JSON.stringify(cliPath)};

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,
  /(api[_-]?key|apikey)\\s*[:=]\\s*["']?[\\w-]{20,}["']?/gi,
  /bearer\\s+[a-zA-Z0-9\\-._~+/]+=*/gi,
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
    appendFileSync(logPath, \`[\${new Date().toISOString()}] \${message}\\n\`);
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
        const content = redactSecrets(\`new auth-related file: \${currentFile}\`);
        cmSave("discovery", content);
        savedItems.push(\`discovery: \${content}\`);
      }
      if (isConfigFile(currentFile)) {
        const content = redactSecrets(\`new config: \${currentFile}\`);
        cmSave("constraint", content);
        savedItems.push(\`constraint: \${content}\`);
      }
      if (isSchemaFile(currentFile)) {
        const content = redactSecrets(\`schema change: \${currentFile}\`);
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
      const content = redactSecrets(\`removed dependency: \${removedModulePath}\`);
      cmSave("rejection", content);
      savedItems.push(\`rejection: \${content}\`);
    }

    if (isPackageJson && inDependenciesSection) {
      const pkgMatch = codeLine.match(/"([a-z][\\w-]+)"\\s*:/);
      if (pkgMatch && pkgMatch[1] !== "dependencies" && pkgMatch[1] !== "devDependencies") {
        const content = redactSecrets(\`removed dependency: \${pkgMatch[1]}\`);
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
          const content = redactSecrets(\`new env var required: \${envMatch[1]}\`);
          cmSave("constraint", content);
          savedItems.push(\`constraint: \${content}\`);
        }
      }
    }

    if (isPackageJson && inDependenciesSection) {
      const pkgMatch = codeLine.match(/"([a-z][\\w-]+)"\\s*:/);
      if (pkgMatch && pkgMatch[1] !== "dependencies" && pkgMatch[1] !== "devDependencies") {
        const content = redactSecrets(\`added dependency: \${pkgMatch[1]}\`);
        cmSave("decision", content);
        savedItems.push(\`decision: \${content}\`);
      }
    }

    if (currentFile && isSchemaFile(currentFile) && /CREATE TABLE|ALTER TABLE|DROP TABLE/i.test(codeLine)) {
      const truncated = codeLine.trim().slice(0, 80);
      const content = redactSecrets(\`database change: \${truncated}\`);
      cmSave("discovery", content);
      savedItems.push(\`discovery: \${content}\`);
    }

    if (/^\\+\\s*(\\/\\/|#)\\s*(TODO:|FIXME:|HACK:|XXX:)/.test(line)) {
      const truncated = codeLine.trim().slice(0, 100);
      const content = redactSecrets(\`open issue from commit: \${truncated}\`);
      cmSave("discovery", content);
      savedItems.push(\`discovery: \${content}\`);
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
const CONVENTIONAL_COMMIT_RE = /^([a-zA-Z]+)(\\([^)]*\\))?!?:\\s*(.+)/;
const CONVENTIONAL_DECISION_TYPES = new Set(["feat", "fix", "perf", "refactor"]);
const CONVENTIONAL_SKIP_TYPES = new Set(["docs", "style", "test", "ci", "build", "chore"]);
const BREAKING_CHANGE_RE = /BREAKING CHANGE:\\s*([\\s\\S]+?)(?:\\n\\n|$)/;

const trimmedCommitMessage = commitMessage.trim();
const commitFirstLine = trimmedCommitMessage.split("\\n")[0];
const conventionalMatch = commitFirstLine.match(CONVENTIONAL_COMMIT_RE);
const conventionalType = conventionalMatch ? conventionalMatch[1].toLowerCase() : null;

const breakingMatch = trimmedCommitMessage.match(BREAKING_CHANGE_RE);
if (breakingMatch) {
  const breakingContent = redactSecrets(breakingMatch[1].trim());
  const content = \`BREAKING CHANGE: \${breakingContent}\`;
  cmSave("constraint", content);
  savedItems.push(\`constraint: \${content}\`);
}

if (conventionalType && CONVENTIONAL_DECISION_TYPES.has(conventionalType)) {
  const trimmedMessage = redactSecrets(trimmedCommitMessage);
  cmSave("decision", trimmedMessage);
  savedItems.push(\`decision: \${trimmedMessage}\`);
} else if (conventionalType && CONVENTIONAL_SKIP_TYPES.has(conventionalType)) {
  // docs/style/test/ci/build/chore — skip entirely, nothing saved.
} else if (isQualityCommitMessage(commitMessage)) {
  const trimmedMessage = redactSecrets(trimmedCommitMessage);
  cmSave("decision", trimmedMessage);
  savedItems.push(\`decision: \${trimmedMessage}\`);
}

console.log(\`coding-memory post-commit summary (\${changedFiles.length} file(s) changed):\`);
for (const item of savedItems) {
  console.log(\`  - \${item}\`);
}

execFileSync("node", [CLI_PATH, "sync"], { stdio: "inherit" });

// cm sync rewrites .cursorrules/.windsurfrules, which would otherwise leave
// the working directory dirty (breaking things like \`npm version patch\`
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
`;
}

// Installs (or re-installs) the stackmem post-commit hook at `hooksDir`. If
// a post-commit hook already exists and wasn't written by stackmem, it's
// preserved as a backup and chained to run before stackmem's own hook,
// rather than being clobbered — see `uninstallHook` for how it's restored.
function installHook(hooksDir: string, hookLogicPath: string): void {
  nodeFs.mkdirSync(hooksDir, { recursive: true });

  const hookPath = nodePath.join(hooksDir, "post-commit");
  const backupPath = nodePath.join(hooksDir, HOOK_BACKUP_FILENAME);

  let chainedOriginal = false;
  if (nodeFs.existsSync(hookPath)) {
    const existingContent = nodeFs.readFileSync(hookPath, "utf-8");
    if (!existingContent.includes(STACKMEM_HOOK_MARKER)) {
      nodeFs.copyFileSync(hookPath, backupPath);
      try {
        nodeFs.chmodSync(backupPath, 0o755);
      } catch {
        // Best-effort — if the original wasn't executable either, leave it.
      }
      chainedOriginal = true;
    }
  }

  const chainLine = chainedOriginal
    ? `"$(dirname "$0")/${HOOK_BACKUP_FILENAME}" "$@"\n`
    : "";

  nodeFs.writeFileSync(
    hookPath,
    `#!/bin/sh\n${STACKMEM_HOOK_MARKER}\n${chainLine}exec node "${hookLogicPath}" "$@"\n`,
    "utf-8"
  );
  nodeFs.chmodSync(hookPath, 0o755);

  if (chainedOriginal) {
    console.log("Existing post-commit hook found — chained it to run before stackmem's hook.");
  }
}

// Reverses `installHook`: if stackmem wrote the hook fresh, removes it; if
// stackmem chained it after an existing hook, restores that original hook
// in its place. Returns a description of what happened, or null if there
// was no stackmem-managed hook to remove (nothing done).
function uninstallHook(hooksDir: string): string | null {
  const hookPath = nodePath.join(hooksDir, "post-commit");
  const backupPath = nodePath.join(hooksDir, HOOK_BACKUP_FILENAME);

  if (!nodeFs.existsSync(hookPath)) return null;

  const content = nodeFs.readFileSync(hookPath, "utf-8");
  if (!content.includes(STACKMEM_HOOK_MARKER)) return null;

  if (nodeFs.existsSync(backupPath)) {
    nodeFs.renameSync(backupPath, hookPath);
    return ".git/hooks/post-commit (restored original hook stackmem had chained)";
  }

  nodeFs.unlinkSync(hookPath);
  return ".git/hooks/post-commit";
}

// Overridable so tests (and `cm uninstall`'s own smoke-testing) can point
// at a scratch file instead of the real ~/.claude.json.
function getClaudeConfigPath(): string {
  return nodePath.join(nodeOs.homedir(), ".claude.json");
}

function registerMcpServer(distIndexPath: string, claudeConfigPath = getClaudeConfigPath()): void {
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

// Returns true if an entry was actually removed.
function unregisterMcpServer(claudeConfigPath = getClaudeConfigPath()): boolean {
  if (!nodeFs.existsSync(claudeConfigPath)) return false;

  let config: { mcpServers?: Record<string, unknown> } = {};
  try {
    config = JSON.parse(nodeFs.readFileSync(claudeConfigPath, "utf-8"));
  } catch {
    return false;
  }

  if (!config.mcpServers || !("stackmem" in config.mcpServers)) return false;

  delete config.mcpServers.stackmem;
  nodeFs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), "utf-8");
  return true;
}

const DEFAULT_GITIGNORE_CONTENT = `node_modules/
dist/
.env
.env.local
.DS_Store
*.log
coverage/
*-memories.json
*.db
`;

// Returns true if the file was created, false if it already existed
// (and was left untouched).
function writeGitignore(resolvedPath: string): boolean {
  const gitignorePath = nodePath.join(resolvedPath, ".gitignore");

  if (nodeFs.existsSync(gitignorePath)) {
    return false;
  }

  nodeFs.writeFileSync(gitignorePath, DEFAULT_GITIGNORE_CONTENT, "utf-8");
  return true;
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

// Section order for the generated rules-file markdown — matches the order
// memories are presented in everywhere else (cm context's CONTEXT_TYPE_ORDER),
// not MEMORY_TYPES' declaration order.
const RULES_FILE_TYPE_ORDER: MemoryType[] = ["decision", "constraint", "rejection", "discovery"];

// Builds the markdown written into .cursorrules / .windsurfrules: the
// project's unresolved memories (decay-ranked, budget-capped so an
// editor's system prompt never balloons) plus its most recent open fixes.
// Shared by `cm init` (first write) and `cm sync` (refresh on every commit).
async function generateRulesContent(project: string): Promise<string> {
  const { data: memoryRows, error: memoriesError } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .eq("resolved", false);

  if (memoriesError) fail(`Failed to load memories: ${memoriesError.message}`);

  const scoredMemories = (memoryRows ?? [])
    .map((memory) => ({
      ...memory,
      decay_score: computeDecayScore(new Date(memory.created_at), memory.access_count ?? 0),
    }))
    .sort((a, b) => b.decay_score - a.decay_score);

  const budgetedMemories = applyContextBudget(scoredMemories, CONTEXT_BUDGET_TOKENS);

  const { data: fixRows, error: fixesError } = await supabase
    .from("execution_log")
    .select("*")
    .eq("project", project)
    .eq("resolved", false)
    .order("created_at", { ascending: false })
    .limit(5);

  if (fixesError) fail(`Failed to load execution log: ${fixesError.message}`);

  const fixes = fixRows ?? [];

  const lines: string[] = [];
  lines.push("# stackmem — project memory (auto-updated)");
  lines.push(`## Project: ${project}`);

  if (budgetedMemories.length === 0 && fixes.length === 0) {
    lines.push("");
    lines.push("No memories yet. Make a commit to start capturing.");
  } else {
    for (const type of RULES_FILE_TYPE_ORDER) {
      const group = budgetedMemories.filter((memory) => memory.type === type);
      if (group.length === 0) continue;

      lines.push("");
      lines.push(`### ${TYPE_LABELS[type]}`);
      for (const memory of group) {
        lines.push(`- ${memory.content}`);
      }
    }

    if (fixes.length > 0) {
      lines.push("");
      lines.push("### Recent Fixes");
      for (const fix of fixes) {
        const solution = fix.solution && fix.solution.trim().length > 0
          ? fix.solution
          : "(solution pending)";
        lines.push(`- ${fix.problem} → ${solution}`);
      }
    }
  }

  lines.push("");
  lines.push("---");
  lines.push(`*Last updated: ${new Date().toLocaleString("en-US")}*`);
  lines.push("*Run `cm start` for full details with decay scores*");
  lines.push("");

  return lines.join("\n");
}

// Returns true if the file was written, false if it already existed
// (and was skipped).
function writeCursorRules(resolvedPath: string, content: string): boolean {
  const cursorRulesPath = nodePath.join(resolvedPath, ".cursorrules");

  if (nodeFs.existsSync(cursorRulesPath)) {
    console.log(".cursorrules already exists — skipping.");
    return false;
  }

  nodeFs.writeFileSync(cursorRulesPath, content, "utf-8");
  console.log(".cursorrules written.");
  return true;
}

// Returns true if the file was written, false if it already existed
// (and was skipped).
function writeWindsurfRules(resolvedPath: string, content: string): boolean {
  const windsurfRulesPath = nodePath.join(resolvedPath, ".windsurfrules");

  if (nodeFs.existsSync(windsurfRulesPath)) {
    console.log(".windsurfrules already exists — skipping.");
    return false;
  }

  nodeFs.writeFileSync(windsurfRulesPath, content, "utf-8");
  console.log(".windsurfrules written.");
  return true;
}

function writeProjectFile(project: string, resolvedPath: string): void {
  const stackmemPath = nodePath.join(resolvedPath, STACKMEM_FILE);
  nodeFs.writeFileSync(stackmemPath, `${project}\n`, "utf-8");
}

// Minimal shape trySeedMemory needs from a Supabase client — narrow enough
// that tests can pass a mock without satisfying the full SupabaseClient type.
interface MemoryInsertClient {
  from(table: string): { insert(row: unknown): PromiseLike<{ error: unknown }> };
}

// Shared by every seedMemories check below: skip the insert if this exact
// content already exists (decideSaveAction's duplicate check) so re-running
// `cm init` on an already-seeded project doesn't pile up repeats. Exported,
// with an injectable client, so this duplicate-prevention guarantee is
// unit-testable without a live Supabase connection.
export async function trySeedMemory(
  project: string,
  existingMemories: { id: string; content: string }[],
  type: MemoryType,
  content: string,
  client: MemoryInsertClient = supabase
): Promise<boolean> {
  const decision = decideSaveAction(content, existingMemories);
  if (decision.action === "duplicate") return false;

  const { error } = await client.from("memories").insert({
    project,
    type,
    content,
    device_id: getDeviceId(),
  });
  return !error;
}

// Scans the freshly-initialized project for a few cheap, high-signal facts
// and saves them as memories directly (bypassing cmdSave's duplicate/conflict
// prompt — there's nothing to conflict with yet, and init must stay
// non-interactive). Returns how many memories were actually saved.
async function seedMemories(project: string, resolvedPath: string): Promise<number> {
  let seededCount = 0;

  const { data: existingRows, error: existingError } = await supabase
    .from("memories")
    .select("id, content")
    .eq("project", project)
    .eq("resolved", false);

  if (existingError) fail(`Failed to load memories: ${existingError.message}`);

  const existingMemories = existingRows ?? [];

  const packageJsonPath = nodePath.join(resolvedPath, "package.json");
  if (nodeFs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(nodeFs.readFileSync(packageJsonPath, "utf-8"));
      const depNames = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ];
      if (depNames.length > 0) {
        const content = `tech stack: ${depNames.join(", ")}`;
        if (await trySeedMemory(project, existingMemories, "discovery", content)) seededCount++;
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
      const content = `required env vars: ${varNames.join(", ")}`;
      if (await trySeedMemory(project, existingMemories, "constraint", content)) seededCount++;
    }
  }

  const tsconfigPath = nodePath.join(resolvedPath, "tsconfig.json");
  if (nodeFs.existsSync(tsconfigPath)) {
    try {
      const tsconfig = JSON.parse(nodeFs.readFileSync(tsconfigPath, "utf-8"));
      const target = tsconfig.compilerOptions?.target;
      const moduleKind = tsconfig.compilerOptions?.module;
      if (target || moduleKind) {
        const content = `TypeScript config: target=${target ?? "unspecified"}, module=${moduleKind ?? "unspecified"}`;
        if (await trySeedMemory(project, existingMemories, "constraint", content)) seededCount++;
      }
    } catch {
      // Malformed tsconfig.json (or JSONC with comments) — skip.
    }
  }

  const readmePath = nodePath.join(resolvedPath, "README.md");
  if (nodeFs.existsSync(readmePath)) {
    const words = nodeFs
      .readFileSync(readmePath, "utf-8")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 100);
    if (words.length > 0) {
      const content = `project description: ${words.join(" ")}`;
      if (await trySeedMemory(project, existingMemories, "discovery", content)) seededCount++;
    }
  }

  const FRAMEWORK_FILE_INDICATORS: { file: string; type: MemoryType; content: string }[] = [
    { file: "next.config.ts", type: "constraint", content: "framework: Next.js" },
    { file: "next.config.js", type: "constraint", content: "framework: Next.js" },
    { file: "vite.config.ts", type: "constraint", content: "framework: Vite" },
    { file: "vite.config.js", type: "constraint", content: "framework: Vite" },
    { file: "Dockerfile", type: "constraint", content: "containerized: Docker" },
  ];
  for (const indicator of FRAMEWORK_FILE_INDICATORS) {
    if (!nodeFs.existsSync(nodePath.join(resolvedPath, indicator.file))) continue;
    if (await trySeedMemory(project, existingMemories, indicator.type, indicator.content)) seededCount++;
  }

  const githubWorkflowsPath = nodePath.join(resolvedPath, ".github", "workflows");
  if (nodeFs.existsSync(githubWorkflowsPath)) {
    const content = "CI/CD: GitHub Actions";
    if (await trySeedMemory(project, existingMemories, "discovery", content)) seededCount++;
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
    console.error(`No git repo found at ${targetPath}. Run 'git init' first, then run 'cm init' again.`);
    process.exit(1);
  }

  const gitignoreCreated = writeGitignore(resolvedPath);

  const codingMemoryDir = nodePath.join(resolvedPath, ".coding-memory");
  nodeFs.mkdirSync(codingMemoryDir, { recursive: true });

  const hookLogicPath = nodePath.join(codingMemoryDir, "post-commit-hook.mjs");
  nodeFs.writeFileSync(hookLogicPath, buildHookLogicScript(DIST_CLI_PATH), "utf-8");

  const hooksDir = nodePath.join(gitDir, "hooks");
  nodeFs.mkdirSync(hooksDir, { recursive: true });

  installHook(hooksDir, hookLogicPath);

  console.log(`coding-memory hook installed for project ${project} at ${targetPath}`);

  registerMcpServer(DIST_INDEX_PATH);
  writeClaudeMd(project, resolvedPath);

  const seededCount = await seedMemories(project, resolvedPath);
  console.log(`Seeded ${seededCount} initial memories from project scan.`);

  const rulesContent = await generateRulesContent(project);
  const cursorRulesWritten = writeCursorRules(resolvedPath, rulesContent);
  const windsurfRulesWritten = writeWindsurfRules(resolvedPath, rulesContent);

  const backendOk = await verifyBackendConnection(project);

  console.log("");
  if (gitignoreCreated) {
    console.log("✓ .gitignore created");
  }
  console.log("✓ Git hook installed");
  console.log("✓ MCP server registered");
  console.log("✓ CLAUDE.md written");
  console.log(
    `✓ .cursorrules ${cursorRulesWritten ? "written" : "already exists"}`
  );
  console.log(
    `✓ .windsurfrules ${windsurfRulesWritten ? "written" : "already exists"}`
  );
  console.log(`✓ Seeded ${seededCount} memories from project scan`);
  if (backendOk) {
    console.log("✓ Backend connection verified");
    console.log("");
    console.log(
      `stackmem is live. Open Claude Code and ask "what do you know about this project?" to verify.`
    );
  } else {
    console.log("✗ Backend connection failed — run 'cm doctor'");
  }

  // Written last and deliberately: if a commit (and hence the post-commit
  // hook) fires anywhere during init, it must still see whatever project
  // .stackmem pointed to before this run, not the one being initialized now.
  writeProjectFile(project, resolvedPath);
}

// --- cm sync ---------------------------------------------------------------

async function cmdSync(project: string) {
  const resolvedPath = process.cwd();
  const rulesContent = await generateRulesContent(project);

  nodeFs.writeFileSync(nodePath.join(resolvedPath, ".cursorrules"), rulesContent, "utf-8");
  nodeFs.writeFileSync(nodePath.join(resolvedPath, ".windsurfrules"), rulesContent, "utf-8");

  console.log("Synced memories to .cursorrules and .windsurfrules");
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

// --- cm doctor ---------------------------------------------------------

// Re-reads the freshly (re)written config to confirm the MCP entry is
// actually there now, rather than trusting registerMcpServer didn't throw.
function isMcpRegistered(claudeConfigPath: string): boolean {
  if (!nodeFs.existsSync(claudeConfigPath)) return false;
  try {
    const config = JSON.parse(nodeFs.readFileSync(claudeConfigPath, "utf-8"));
    return Boolean(config?.mcpServers?.stackmem);
  } catch {
    return false;
  }
}

function isHookExecutable(hookPath: string): boolean {
  if (!nodeFs.existsSync(hookPath)) return false;
  try {
    nodeFs.accessSync(hookPath, nodeFs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function cmdDoctor(fix: boolean) {
  let issues = 0;
  const project = readProjectFromFile();

  // 1. Backend connection
  const backendOk = await verifyBackendConnection(project ?? "");
  if (backendOk) {
    console.log("✓ Backend connection verified");
  } else {
    console.log("✗ Backend connection failed — check your network");
    issues++;
    if (fix) {
      console.log(
        "Could not auto-fix: backend connection — check your network and Supabase status, then re-run 'cm doctor'."
      );
    }
  }

  // 2. MCP server registration
  const claudeConfigPath = getClaudeConfigPath();
  const mcpRegistered = isMcpRegistered(claudeConfigPath);
  if (mcpRegistered) {
    console.log("✓ MCP server registered with Claude Code");
  } else {
    console.log("✗ MCP server not registered — run 'cm init <project> .'");
    issues++;
    if (fix) {
      registerMcpServer(DIST_INDEX_PATH, claudeConfigPath);
      if (isMcpRegistered(claudeConfigPath)) {
        console.log("Fixed: MCP server registration");
        issues--;
      } else {
        console.log("Could not auto-fix: MCP server registration");
      }
    }
  }

  // 3. Project file
  if (project) {
    console.log(`✓ Project file found: ${project}`);
  } else {
    console.log("✗ No .stackmem found — run 'cm init <project> .'");
    issues++;
    if (fix) {
      console.log("Could not auto-fix: .stackmem file — run 'cm init <project> .'");
    }
  }

  // 4. Git hook
  const gitDir = nodePath.join(process.cwd(), ".git");
  if (!nodeFs.existsSync(gitDir)) {
    console.log("✗ No git repo found in current directory");
    issues++;
  } else {
    const hooksDir = nodePath.join(gitDir, "hooks");
    const hookPath = nodePath.join(hooksDir, "post-commit");

    if (isHookExecutable(hookPath)) {
      console.log("✓ Git hook installed");
    } else {
      console.log("✗ Git hook not installed — run 'cm init <project> .'");
      issues++;
      if (fix) {
        const codingMemoryDir = nodePath.join(process.cwd(), ".coding-memory");
        nodeFs.mkdirSync(codingMemoryDir, { recursive: true });
        const hookLogicPath = nodePath.join(codingMemoryDir, "post-commit-hook.mjs");
        nodeFs.writeFileSync(hookLogicPath, buildHookLogicScript(DIST_CLI_PATH), "utf-8");
        installHook(hooksDir, hookLogicPath);

        if (isHookExecutable(hookPath)) {
          console.log("Fixed: git hook");
          issues--;
        } else {
          console.log("Could not auto-fix: git hook");
        }
      }
    }
  }

  // 5. Memory count
  let hasMemories = false;
  if (project) {
    const { count, error } = await supabase
      .from("memories")
      .select("id", { count: "exact", head: true })
      .eq("project", project)
      .eq("resolved", false);

    hasMemories = !error && (count ?? 0) > 0;
    if (hasMemories) {
      console.log(`✓ ${count} memories stored for "${project}"`);
    }
  }
  if (!hasMemories) {
    console.log(`✗ No memories yet — make a commit to start capturing`);
    issues++;
    if (fix) {
      console.log("Could not auto-fix: memories — make a commit to start capturing");
    }
  }

  console.log("");
  if (issues === 0) {
    console.log("All systems operational.");
  } else {
    console.log(`${issues} issue(s) found. See above.`);
  }
}

// --- cm undo -------------------------------------------------------------

async function cmdUndo(project: string) {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .eq("resolved", false)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) fail(`Failed to load most recent memory: ${error.message}`);

  const memory = (data ?? [])[0];
  if (!memory) {
    console.log("Nothing to undo.");
    return;
  }

  const { error: linksError } = await supabase
    .from("memory_links")
    .delete()
    .or(`source_id.eq.${memory.id},target_id.eq.${memory.id}`);

  if (linksError) fail(`Failed to delete memory links: ${linksError.message}`);

  const { error: deleteError } = await supabase.from("memories").delete().eq("id", memory.id);

  if (deleteError) fail(`Failed to delete memory: ${deleteError.message}`);

  console.log(`Undone: [${memory.type}] ${memory.content}`);
}

// --- cm export -------------------------------------------------------------

async function cmdExport(project: string, filename?: string) {
  const { data: memories, error: memoriesError } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .eq("resolved", false);

  if (memoriesError) fail(`Failed to load memories: ${memoriesError.message}`);

  const { data: executionLog, error: executionLogError } = await supabase
    .from("execution_log")
    .select("*")
    .eq("project", project);

  if (executionLogError) fail(`Failed to load execution log: ${executionLogError.message}`);

  const memoryResults = memories ?? [];
  const memoryIds = memoryResults.map((m) => m.id);

  let memoryLinks: unknown[] = [];
  if (memoryIds.length > 0) {
    const idList = memoryIds.join(",");
    const { data: links, error: linksError } = await supabase
      .from("memory_links")
      .select("*")
      .or(`source_id.in.(${idList}),target_id.in.(${idList})`);

    if (linksError) fail(`Failed to load memory links: ${linksError.message}`);
    memoryLinks = links ?? [];
  }

  const exportData = {
    project,
    exported_at: new Date().toISOString(),
    memories: memoryResults,
    execution_log: executionLog ?? [],
    memory_links: memoryLinks,
  };

  const outputFilename = filename ?? `${project}-memories.json`;
  nodeFs.writeFileSync(outputFilename, JSON.stringify(exportData, null, 2), "utf-8");

  console.log(`Exported ${memoryResults.length} memories to ${outputFilename}`);
}

// --- cm import -------------------------------------------------------------

async function cmdImport(project: string, filename: string) {
  if (!nodeFs.existsSync(filename)) {
    console.log(`File not found: ${filename}`);
    return;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(nodeFs.readFileSync(filename, "utf-8"));
  } catch (error) {
    fail(`Failed to parse ${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const memories = Array.isArray(parsed.memories) ? parsed.memories : [];
  const executionLogEntries = Array.isArray(parsed.execution_log) ? parsed.execution_log : [];

  // memory_links are intentionally skipped — they get rebuilt by semantic
  // linking the next time cm save runs against the imported memories.

  let importedCount = 0;
  for (const memory of memories) {
    const { error } = await supabase.from("memories").insert({
      project,
      type: memory.type,
      content: memory.content,
      device_id: getDeviceId(),
    });
    if (!error) importedCount++;
  }

  for (const entry of executionLogEntries) {
    await supabase.from("execution_log").insert({
      project,
      problem: entry.problem,
      solution: entry.solution ?? null,
      resolved: entry.resolved ?? false,
      device_id: getDeviceId(),
    });
  }

  console.log(`Imported ${importedCount} memories from ${filename}`);
}

// --- cm uninstall ------------------------------------------------------

function readProjectFromPath(dirPath: string): string | null {
  const stackmemPath = nodePath.join(dirPath, STACKMEM_FILE);
  if (!nodeFs.existsSync(stackmemPath)) return null;
  const content = nodeFs.readFileSync(stackmemPath, "utf-8").trim();
  return content.length > 0 ? content : null;
}

// Removes a marker-gated file (CLAUDE.md / .cursorrules / .windsurfrules)
// only if it still carries the stackmem marker — a file the user has since
// rewritten by hand, or never had stackmem's content to begin with, is left
// alone rather than silently deleted.
function removeIfMarked(filePath: string, marker: string, label: string): void {
  if (!nodeFs.existsSync(filePath)) return;

  const content = nodeFs.readFileSync(filePath, "utf-8");
  if (!content.includes(marker)) {
    console.log(`Skipped ${label} (no stackmem marker found — left as-is).`);
    return;
  }

  nodeFs.unlinkSync(filePath);
  console.log(`Removed ${label}`);
}

async function cmdUninstall(project: string, targetPath: string) {
  const gitDir = nodePath.join(targetPath, ".git");
  const hooksDir = nodePath.join(gitDir, "hooks");

  const hookResult = uninstallHook(hooksDir);
  if (hookResult) console.log(`Removed ${hookResult}`);

  const codingMemoryDir = nodePath.join(targetPath, ".coding-memory");

  const hookLogicPath = nodePath.join(codingMemoryDir, "post-commit-hook.mjs");
  if (nodeFs.existsSync(hookLogicPath)) {
    nodeFs.unlinkSync(hookLogicPath);
    console.log("Removed .coding-memory/post-commit-hook.mjs");
  }

  const astDbPath = nodePath.join(codingMemoryDir, "ast-index.db");
  if (nodeFs.existsSync(astDbPath)) {
    nodeFs.unlinkSync(astDbPath);
    console.log("Removed .coding-memory/ast-index.db");
  }

  if (nodeFs.existsSync(codingMemoryDir) && nodeFs.readdirSync(codingMemoryDir).length === 0) {
    nodeFs.rmdirSync(codingMemoryDir);
    console.log("Removed .coding-memory/ directory");
  }

  const stackmemPath = nodePath.join(targetPath, STACKMEM_FILE);
  if (nodeFs.existsSync(stackmemPath)) {
    nodeFs.unlinkSync(stackmemPath);
    console.log("Removed .stackmem");
  }

  removeIfMarked(nodePath.join(targetPath, "CLAUDE.md"), CLAUDE_MD_MARKER, "CLAUDE.md");
  removeIfMarked(nodePath.join(targetPath, ".cursorrules"), RULES_FILE_MARKER, ".cursorrules");
  removeIfMarked(nodePath.join(targetPath, ".windsurfrules"), RULES_FILE_MARKER, ".windsurfrules");

  if (unregisterMcpServer()) {
    console.log("Removed stackmem entry from ~/.claude.json mcpServers");
  }

  console.log(`stackmem uninstalled from ${project}.`);
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
      // Exactly two positional args can only mean <type> <content> with the
      // project omitted — an explicit project would need a third slot for
      // content, which wouldn't exist. Without this check, a typo'd type
      // (failing the MEMORY_TYPES.includes test below) used to fall into
      // the "explicit project" branch instead, shifting content out of
      // existence and surfacing a generic usage() dump instead of the
      // targeted invalid-type error.
      if (positional.length === 2 || MEMORY_TYPES.includes(positional[0] as MemoryType)) {
        explicitProject = null;
        [type, ...rest] = positional;
      } else {
        explicitProject = positional[0] ?? null;
        [, type, ...rest] = positional;
      }

      if (type !== undefined && !MEMORY_TYPES.includes(type as MemoryType)) {
        fail(`Invalid memory type '${type}'. Valid types: decision, constraint, discovery, rejection.`);
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
    case "inspect": {
      const split = splitOptionalProject(args, 1);
      if (!split) usage();
      const project = requireProject(split.project);
      const [memoryId] = split.rest;
      await cmdInspect(project, memoryId);
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
    case "sync": {
      if (args.length > 0) usage();
      const project = requireProject(null);
      await cmdSync(project);
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
    case "doctor": {
      const fix = args.includes("--fix");
      await cmdDoctor(fix);
      break;
    }
    case "undo": {
      const split = splitOptionalProject(args, 0);
      if (!split) usage();
      const project = requireProject(split.project);
      await cmdUndo(project);
      break;
    }
    case "export": {
      if (args.length > 1) usage();
      const [filename] = args;
      const project = requireProject(null);
      await cmdExport(project, filename);
      break;
    }
    case "import": {
      const split = splitOptionalProject(args, 1);
      if (!split) usage();
      const project = requireProject(split.project);
      const [filename] = split.rest;
      await cmdImport(project, filename);
      break;
    }
    case "uninstall": {
      if (args.length > 2) usage();

      let explicitProject: string | null = null;
      let targetPath = process.cwd();
      if (args.length === 1) {
        if (looksLikeAPath(args[0])) {
          targetPath = args[0];
        } else {
          explicitProject = args[0];
        }
      } else if (args.length === 2) {
        [explicitProject, targetPath] = args;
      }

      const resolvedPath = nodePath.resolve(targetPath);
      const project = explicitProject ?? readProjectFromPath(resolvedPath);
      if (!project) {
        console.error(`No project specified and no .stackmem file found at ${resolvedPath}.`);
        process.exit(1);
      }

      await cmdUninstall(project, resolvedPath);
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

// Guards the auto-run so importing this module (e.g. from a test file, to
// reach exported helpers like trySeedMemory) doesn't also execute main()
// against the test runner's own argv. realpathSync matters here: the `cm`
// bin is typically a symlink (npm link, or the global install this project
// itself uses), and process.argv[1] preserves the symlink path as invoked
// while import.meta.url resolves to the link's real target — comparing
// them raw would never match, silently skipping main() entirely.
function resolveMainModulePath(argvPath: string): string | null {
  try {
    return pathToFileURL(nodeFs.realpathSync(argvPath)).href;
  } catch {
    return null;
  }
}

const isMainModule =
  process.argv[1] != null && import.meta.url === resolveMainModulePath(process.argv[1]);
if (isMainModule) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
