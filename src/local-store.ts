import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// .coding-memory/local-store.json — same shape as the Supabase memories/
// execution_log tables, so local-mode code can reuse scoring.ts's pure
// functions (computeDecayScore, scoreMemoryRelevance, decideSaveAction)
// unchanged; only the storage layer differs.
export const LOCAL_STORE_RELATIVE_PATH = path.join(".coding-memory", "local-store.json");

export interface LocalMemory {
  id: string;
  project: string;
  type: string;
  content: string;
  resolved: boolean;
  created_at: string;
  access_count: number;
  pinned: boolean;
  suggested: boolean;
  commit_sha: string | null;
  file_paths: string[] | null;
  author: string | null;
  source: string;
  confidence: number;
}

export interface LocalFix {
  id: string;
  project: string;
  problem: string;
  solution: string | null;
  resolved: boolean;
  created_at: string;
}

interface LocalStoreFile {
  memories: LocalMemory[];
  execution_log: LocalFix[];
}

function localStorePath(resolvedPath: string = process.cwd()): string {
  return path.join(resolvedPath, LOCAL_STORE_RELATIVE_PATH);
}

function readLocalStore(resolvedPath?: string): LocalStoreFile {
  try {
    const raw = fs.readFileSync(localStorePath(resolvedPath), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      memories: Array.isArray(parsed.memories) ? parsed.memories : [],
      execution_log: Array.isArray(parsed.execution_log) ? parsed.execution_log : [],
    };
  } catch {
    return { memories: [], execution_log: [] };
  }
}

function writeLocalStore(store: LocalStoreFile, resolvedPath?: string): void {
  const filePath = localStorePath(resolvedPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
}

export function localListMemories(project: string, resolvedPath?: string): LocalMemory[] {
  return readLocalStore(resolvedPath).memories.filter((m) => m.project === project && !m.resolved);
}

export function localSaveMemory(
  project: string,
  type: string,
  content: string,
  overrides: Partial<Pick<LocalMemory, "source" | "confidence" | "commit_sha" | "file_paths" | "author">> = {}
): LocalMemory {
  const store = readLocalStore();
  const memory: LocalMemory = {
    id: randomUUID(),
    project,
    type,
    content,
    resolved: false,
    created_at: new Date().toISOString(),
    access_count: 0,
    pinned: false,
    suggested: false,
    commit_sha: overrides.commit_sha ?? null,
    file_paths: overrides.file_paths ?? null,
    author: overrides.author ?? null,
    source: overrides.source ?? "manual",
    confidence: overrides.confidence ?? 1.0,
  };
  store.memories.push(memory);
  writeLocalStore(store);
  return memory;
}

export function localResolveMemory(id: string): void {
  const store = readLocalStore();
  const memory = store.memories.find((m) => m.id === id);
  if (memory) {
    memory.resolved = true;
    writeLocalStore(store);
  }
}

export function localIncrementAccessCounts(ids: string[]): void {
  if (ids.length === 0) return;
  const store = readLocalStore();
  const idSet = new Set(ids);
  for (const memory of store.memories) {
    if (idSet.has(memory.id)) memory.access_count = (memory.access_count ?? 0) + 1;
  }
  writeLocalStore(store);
}

export function localListFixes(project: string, resolvedPath?: string): LocalFix[] {
  return readLocalStore(resolvedPath).execution_log.filter((f) => f.project === project && !f.resolved);
}

export function localSaveFix(project: string, problem: string, solution: string): LocalFix {
  const store = readLocalStore();
  const fix: LocalFix = {
    id: randomUUID(),
    project,
    problem,
    solution,
    resolved: false,
    created_at: new Date().toISOString(),
  };
  store.execution_log.push(fix);
  writeLocalStore(store);
  return fix;
}
