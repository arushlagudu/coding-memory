#!/usr/bin/env tsx
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { analyzeCodebase } from "./ast-index.js";
import { extractEntities, containmentScore } from "./scoring.js";

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
  cm search <project> <query>`);
  process.exit(1);
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

  const memoryIds = memories.map((m) => m.id);
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

  console.log(`Loaded ${memories.length} memory(ies) for "${project}".\n`);

  for (const type of MEMORY_TYPES) {
    const group = memories.filter((m) => m.type === type);
    if (group.length === 0) continue;

    console.log(`${TYPE_LABELS[type]} (${group.length})`);
    console.log("-".repeat(TYPE_LABELS[type].length + 4));
    for (const memory of group) {
      console.log(`  [${memory.id}] ${memory.content}`);
      const linked = Array.from(linkedIdsByMemory.get(memory.id) ?? []);
      if (linked.length > 0) {
        console.log(`      linked: ${linked.join(", ")}`);
      }
    }
    console.log("");
  }
}

// --- cm save -------------------------------------------------------------

async function cmdSave(project: string, type: string, content: string) {
  if (!MEMORY_TYPES.includes(type as MemoryType)) {
    fail(`Invalid type "${type}". Must be one of: ${MEMORY_TYPES.join(", ")}`);
  }

  const { data: inserted, error } = await supabase
    .from("memories")
    .insert({ project, type, content })
    .select("id")
    .single();

  if (error || !inserted) fail(`Failed to save memory: ${error?.message ?? "no row returned"}`);

  const newMemoryId = inserted.id;

  const { data: recentMemories, error: recentError } = await supabase
    .from("memories")
    .select("id, content")
    .eq("project", project)
    .eq("resolved", false)
    .neq("id", newMemoryId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (recentError) fail(`Failed to load memories for linking: ${recentError.message}`);

  const existingMemories = recentMemories ?? [];
  const existingEntities = existingMemories.map((existing) => extractEntities(existing.content));
  const newEntities = extractEntities(content);

  const links = existingMemories
    .map((existing, index) => ({
      source_id: newMemoryId,
      target_id: existing.id,
      score: containmentScore(newEntities, existingEntities[index]),
    }))
    .filter((link) => link.score > 0.15);

  if (links.length > 0) {
    const { error: linkError } = await supabase.from("memory_links").insert(links);
    if (linkError) fail(`Failed to save memory links: ${linkError.message}`);
  }

  console.log(`Saved ${type} [${newMemoryId}] for "${project}".`);
  if (links.length > 0) {
    console.log(`Linked to ${links.length} existing memory(ies): ${links.map((l) => l.target_id).join(", ")}`);
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
  const { data, error } = await supabase
    .from("execution_log")
    .select("*")
    .eq("project", project)
    .eq("resolved", false)
    .or(`problem.ilike.%${query}%,solution.ilike.%${query}%`);

  if (error) fail(`Failed to search past solutions: ${error.message}`);

  const results = data ?? [];
  if (results.length === 0) {
    console.log(`No past solutions found for "${query}" in "${project}".`);
    return;
  }

  console.log(`Found ${results.length} result(s) for "${query}":\n`);
  for (const result of results) {
    console.log(`  Problem:  ${result.problem}`);
    console.log(`  Solution: ${result.solution}`);
    console.log("");
  }
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
    default:
      usage();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
