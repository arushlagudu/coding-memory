#!/usr/bin/env tsx
// Benchmark suite for stackmem's scoring algorithms, run against real
// Supabase data (not fixtures). Two Supabase queries total — one for all
// memories, one for all memory_links — everything else below is derived
// from those two result sets in memory, so re-running this doesn't hammer
// the backend. Run with: npx tsx src/benchmark.ts
import { execSync } from "node:child_process";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyContextBudget,
  computeDecayScore,
  containmentScore,
  decideSaveAction,
  estimateTokens,
  extractEntities,
  scoreMemoryRelevance,
  type ExistingMemory,
} from "./scoring.js";
import { supabase } from "./storage.js";

const CONTEXT_BUDGET_TOKENS = 2000;
const REPO_ROOT = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

// Literal content prefixes the git hook template (buildHookLogicScript in
// src/cli.ts) generates. Any memory starting with one of these was
// unambiguously auto-captured, regardless of who ran the commit. Shared by
// section 4 (template-collision false positives) and section 6 (automation
// rate / captured-category listing).
const HOOK_TEMPLATE_PREFIXES = [
  { label: "new auth-related file → discovery", prefix: "new auth-related file:" },
  { label: "new config file → constraint", prefix: "new config:" },
  { label: "schema change → discovery", prefix: "schema change:" },
  { label: "removed dependency → rejection", prefix: "removed dependency:" },
  { label: "added dependency → decision", prefix: "added dependency:" },
  { label: "database change → discovery", prefix: "database change:" },
  { label: "open TODO/FIXME/HACK/XXX comment → discovery", prefix: "open issue from commit:" },
];

interface MemoryRow {
  id: string;
  project: string;
  type: string;
  content: string;
  resolved: boolean;
  access_count: number | null;
  created_at: string;
}

interface MemoryLinkRow {
  source_id: string;
  target_id: string;
  score: number;
}

// --- deterministic sampling -------------------------------------------------

// A "publishable" benchmark should give the same numbers on every run, but
// the duplicate/contradiction tests below need a varied cross-section of
// real content rather than always the first N rows. A seeded PRNG gets
// both: varied sampling that's identical every time this file is run.
const BENCHMARK_SEED = 1337;

function seededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const rng = seededRandom(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function generateAllPairs<T>(items: T[]): [T, T][] {
  const pairs: [T, T][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      pairs.push([items[i], items[j]]);
    }
  }
  return pairs;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// --- shared data fetch -------------------------------------------------------

async function fetchAllMemories(): Promise<MemoryRow[]> {
  const { data, error } = await supabase.from("memories").select("*");
  if (error) throw new Error(`Failed to fetch memories: ${error.message}`);
  return data ?? [];
}

async function fetchAllLinks(): Promise<MemoryLinkRow[]> {
  const { data, error } = await supabase.from("memory_links").select("source_id, target_id, score");
  if (error) throw new Error(`Failed to fetch memory_links: ${error.message}`);
  return data ?? [];
}

// --- shared: cm start's exact injection pipeline ------------------------------

// Mirrors cmdStart's exact pipeline (decay-sort, then applyContextBudget) so
// anything built on this measures the real injection path, not an idealized
// one. Shared by section 0 (stackmem's token count there must match section
// 1's, since they're both "what cm start actually injects for this project")
// and section 1 itself.
function getBudgetedMemoriesForProject(allMemories: MemoryRow[], project: string): MemoryRow[] {
  const rows = allMemories.filter((m) => m.project === project && !m.resolved);
  const scored = rows
    .map((m) => ({
      ...m,
      decay_score: computeDecayScore(new Date(m.created_at), m.access_count ?? 0),
    }))
    .sort((a, b) => b.decay_score - a.decay_score);
  return applyContextBudget(scored, CONTEXT_BUDGET_TOKENS);
}

// --- 0. comparative baseline --------------------------------------------------

const COMPARATIVE_PROJECT = "coding-memory";
const EXCLUDED_SCAN_DIRS = new Set(["node_modules", "dist", ".git"]);

function listTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_SCAN_DIRS.has(entry.name)) continue;
    const fullPath = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...listTsFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".ts")) results.push(fullPath);
  }
  return results;
}

interface FullDumpResult {
  filesScanned: number;
  totalTokens: number;
}

// What a developer would actually paste if they tried to hand-feed Claude
// the whole codebase for context, instead of using stackmem.
function benchmarkFullCodebaseDump(): FullDumpResult {
  const files = listTsFiles(REPO_ROOT);
  const totalTokens = files.reduce(
    (sum, file) => sum + estimateTokens(nodeFs.readFileSync(file, "utf-8")),
    0
  );
  return { filesScanned: files.length, totalTokens };
}

interface KeyFactsCoverage {
  techStack: boolean;
  activeConstraints: boolean;
  recentDecisions: boolean;
  knownFixes: boolean;
}

function computeKeyFactsCoverage(budgeted: MemoryRow[]): KeyFactsCoverage {
  return {
    techStack: budgeted.some((m) => /^tech stack:/i.test(m.content)),
    activeConstraints: budgeted.some((m) => m.type === "constraint"),
    recentDecisions: budgeted.some((m) => m.type === "decision"),
    // cmdStart (src/cli.ts) only ever selects from the memories table —
    // execution_log is never part of what `cm start` injects, so this is
    // categorically false here regardless of how many real fixes exist in
    // execution_log, not a sampling artifact of this benchmark.
    knownFixes: false,
  };
}

interface ComparativeBaselineResult {
  approachA: { tokens: number; coveragePct: number };
  approachB: FullDumpResult;
  approachC: {
    tokens: number;
    coverage: KeyFactsCoverage;
    factsCovered: number;
    coveragePct: number;
  };
}

function benchmarkComparativeBaseline(allMemories: MemoryRow[]): ComparativeBaselineResult {
  const dump = benchmarkFullCodebaseDump();

  const budgeted = getBudgetedMemoriesForProject(allMemories, COMPARATIVE_PROJECT);
  const tokens = budgeted.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const coverage = computeKeyFactsCoverage(budgeted);
  const factsCovered = Object.values(coverage).filter(Boolean).length;

  return {
    approachA: { tokens: 0, coveragePct: 0 },
    approachB: dump,
    approachC: { tokens, coverage, factsCovered, coveragePct: factsCovered / 4 },
  };
}

// --- 1. token efficiency -----------------------------------------------------

interface TokenEfficiencyResult {
  perProject: { project: string; rawTokens: number; injectedTokens: number }[];
  totalRaw: number;
  totalInjected: number;
}

function benchmarkTokenEfficiency(allMemories: MemoryRow[]): TokenEfficiencyResult {
  const unresolved = allMemories.filter((m) => !m.resolved);
  const projects = [...new Set(unresolved.map((m) => m.project))];

  const perProject: TokenEfficiencyResult["perProject"] = [];
  let totalRaw = 0;
  let totalInjected = 0;

  for (const project of projects) {
    const rows = unresolved.filter((m) => m.project === project);
    const rawTokens = rows.reduce((sum, m) => sum + estimateTokens(m.content), 0);

    const budgeted = getBudgetedMemoriesForProject(allMemories, project);
    const injectedTokens = budgeted.reduce((sum, m) => sum + estimateTokens(m.content), 0);

    perProject.push({ project, rawTokens, injectedTokens });
    totalRaw += rawTokens;
    totalInjected += injectedTokens;
  }

  perProject.sort((a, b) => b.rawTokens - a.rawTokens);
  return { perProject, totalRaw, totalInjected };
}

// --- 2. context relevance (precision@5) --------------------------------------

const CONTEXT_RELEVANCE_PROJECT = "coding-memory";

interface ContextTask {
  description: string;
  // Manually reviewed against the live coding-memory dataset on 2026-10-11:
  // the memory ids genuinely relevant to this task's intent, not just
  // lexically similar. An empty list means no memory in the current
  // dataset actually covers that task — a real retrieval gap, not a bug in
  // this harness. Re-curate these if the memory set changes significantly.
  relevantIds: string[];
}

const CONTEXT_TASKS: ContextTask[] = [
  {
    description: "setting up npm publishing and versioning",
    relevantIds: ["a5aab9dc-49b6-4bbc-aac2-5e65ace3e4ac"], // hosted Supabase backend, npm publish as stackmem
  },
  {
    description: "fixing git hook to prevent recursion",
    // No memory documents the [skip ci] recursion guard: the commit that
    // introduced it used a "test:" prefix, which the quality filter drops.
    relevantIds: [],
  },
  {
    description: "adding Supabase database storage",
    relevantIds: ["a5aab9dc-49b6-4bbc-aac2-5e65ace3e4ac"], // hosted Supabase backend, npm publish as stackmem
  },
  {
    description: "implementing decay scoring algorithm",
    // No memory documents computeDecayScore's implementation itself.
    relevantIds: [],
  },
  {
    description: "building cursor and windsurf support",
    relevantIds: ["86006f9a-159a-4d88-bc94-018edc32cbf4"], // write .cursorrules and .windsurfrules on cm init
  },
];

interface ContextRelevanceTaskResult {
  task: string;
  hits: number;
  precisionAt5: number;
  precisionAt1: number;
}

function benchmarkContextRelevance(allMemories: MemoryRow[]): {
  results: ContextRelevanceTaskResult[];
  average: number;
} {
  const pool = allMemories.filter((m) => m.project === CONTEXT_RELEVANCE_PROJECT && !m.resolved);

  const results = CONTEXT_TASKS.map((task) => {
    const ranked = pool
      .map((m) => ({ ...m, relevance: scoreMemoryRelevance(m.content, task.description) }))
      .sort((a, b) => b.relevance - a.relevance);

    const top5 = ranked.slice(0, 5);
    const relevantSet = new Set(task.relevantIds);
    const hits = top5.filter((m) => relevantSet.has(m.id)).length;
    const top1Hit = ranked.length > 0 && relevantSet.has(ranked[0].id);

    return {
      task: task.description,
      hits,
      precisionAt5: hits / 5,
      precisionAt1: top1Hit ? 1 : 0,
    };
  });

  const average = results.reduce((sum, r) => sum + r.precisionAt5, 0) / results.length;
  return { results, average };
}

// --- 3. duplicate detection accuracy ------------------------------------------

interface ClassificationResult {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

interface DuplicateDetectionResult extends ClassificationResult {
  // FNs split by root cause, since "miss" alone doesn't explain why: a
  // self-pair can fail to register as a duplicate either because the
  // negation-word carve-out misfires (content like "removed dependency: X"
  // reads as a supersede of itself) or because the content has no
  // extractable entities at all (e.g. "wip" — every word under the 5-char
  // minimum), leaving containment permanently at 0.
  fnViaNegationCarveout: number;
  fnViaNoExtractableEntities: number;
}

function scoreClassification(tp: number, fp: number, tn: number, fn: number): ClassificationResult {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, tn, fn, precision, recall, f1 };
}

const SAMPLE_SIZE = 20;

// The system refuses to persist true duplicate rows in the first place
// (decideSaveAction skips the insert), so there's no "same content saved
// twice" to mine directly from the table. The faithful equivalent is
// re-submitting a real memory's exact content as if saving it again —
// literally the scenario the duplicate check exists to catch.
function benchmarkDuplicateDetection(
  allMemories: MemoryRow[],
  unrelatedPairs: [MemoryRow, MemoryRow][]
): DuplicateDetectionResult {
  const positiveSample = seededShuffle(allMemories, BENCHMARK_SEED + 1).slice(0, SAMPLE_SIZE);

  let tp = 0;
  let fn = 0;
  let fnViaNegationCarveout = 0;
  let fnViaNoExtractableEntities = 0;
  for (const memory of positiveSample) {
    const existing: ExistingMemory[] = [{ id: memory.id, content: memory.content }];
    const result = decideSaveAction(memory.content, existing);
    if (result.action === "duplicate") {
      tp++;
    } else {
      fn++;
      if (result.action === "superseded") fnViaNegationCarveout++;
      else if (extractEntities(memory.content).size === 0) fnViaNoExtractableEntities++;
    }
  }

  let tn = 0;
  let fp = 0;
  for (const [a, b] of unrelatedPairs) {
    const existing: ExistingMemory[] = [{ id: b.id, content: b.content }];
    const result = decideSaveAction(a.content, existing);
    if (result.action === "duplicate") fp++;
    else tn++;
  }

  return { ...scoreClassification(tp, fp, tn, fn), fnViaNegationCarveout, fnViaNoExtractableEntities };
}

// --- 4. contradiction detection accuracy --------------------------------------

// Prepending to the full original content guarantees the new entity set is
// a superset of the old one, so containment is ~1.0 by construction — this
// isolates whether the negation-word carve-out in decideSaveAction fires at
// all, not whether it can detect partial-overlap contradictions (e.g.
// "switched from Postgres to Supabase" against "using Postgres"), which is
// a harder, unverified case this benchmark doesn't cover.
const CONTRADICTION_PREFIXES = ["switched from ", "no longer using "];

interface ContradictionDetectionResult extends ClassificationResult {
  // Both unrelated memories sharing a short template ("removed dependency:
  // X" / "removed dependency: Y") push containment over CONTRADICTION_MIN
  // on template words alone, even though the actual payloads (X vs Y) are
  // unrelated — a template-collision false positive, distinct from any
  // other way the negation carve-out could misfire.
  fpViaTemplateCollision: number;
}

function benchmarkContradictionDetection(
  allMemories: MemoryRow[],
  unrelatedPairs: [MemoryRow, MemoryRow][]
): ContradictionDetectionResult {
  const baseSample = seededShuffle(allMemories, BENCHMARK_SEED + 2).slice(0, SAMPLE_SIZE / 2);

  let tp = 0;
  let fn = 0;
  for (const memory of baseSample) {
    for (const prefix of CONTRADICTION_PREFIXES) {
      const existing: ExistingMemory[] = [{ id: memory.id, content: memory.content }];
      const result = decideSaveAction(`${prefix}${memory.content}`, existing);
      if (result.action === "superseded") tp++;
      else fn++;
    }
  }

  // Reuses the same unrelated-pair sample from section 3 as the negative
  // set: if two unrelated memories get flagged "superseded" against each
  // other, that's a false positive here just as "duplicate" was there.
  let tn = 0;
  let fp = 0;
  let fpViaTemplateCollision = 0;
  for (const [a, b] of unrelatedPairs) {
    const existing: ExistingMemory[] = [{ id: b.id, content: b.content }];
    const result = decideSaveAction(a.content, existing);
    if (result.action === "superseded") {
      fp++;
      const sharedPrefix = HOOK_TEMPLATE_PREFIXES.find(
        (p) => a.content.startsWith(p.prefix) && b.content.startsWith(p.prefix)
      );
      if (sharedPrefix) fpViaTemplateCollision++;
    } else {
      tn++;
    }
  }

  return { ...scoreClassification(tp, fp, tn, fn), fpViaTemplateCollision };
}

// --- 5. semantic linking quality ----------------------------------------------

interface SemanticLinkingResult {
  avgLinkScore: number;
  avgRandomPairScore: number;
  signalToNoiseRatio: number;
  linkCount: number;
  baselinePairCount: number;
}

// Baseline is every same-project pair that ISN'T linked, computed
// exhaustively rather than randomly sampled — at this data size (a few
// thousand possible pairs at most) exhaustive is cheap and gives a more
// stable number than a small random draw would.
function benchmarkSemanticLinking(allMemories: MemoryRow[], allLinks: MemoryLinkRow[]): SemanticLinkingResult {
  const avgLinkScore =
    allLinks.length === 0 ? 0 : allLinks.reduce((sum, l) => sum + l.score, 0) / allLinks.length;

  const linkedPairKeys = new Set(allLinks.map((l) => pairKey(l.source_id, l.target_id)));

  const byProject = new Map<string, MemoryRow[]>();
  for (const memory of allMemories) {
    if (!byProject.has(memory.project)) byProject.set(memory.project, []);
    byProject.get(memory.project)!.push(memory);
  }

  let baselineSum = 0;
  let baselineCount = 0;
  for (const rows of byProject.values()) {
    const entitiesById = new Map(rows.map((m) => [m.id, extractEntities(m.content)]));
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const key = pairKey(rows[i].id, rows[j].id);
        if (linkedPairKeys.has(key)) continue;
        baselineSum += containmentScore(entitiesById.get(rows[i].id)!, entitiesById.get(rows[j].id)!);
        baselineCount++;
      }
    }
  }

  const avgRandomPairScore = baselineCount === 0 ? 0 : baselineSum / baselineCount;
  const signalToNoiseRatio =
    avgRandomPairScore === 0 ? (avgLinkScore > 0 ? Infinity : 0) : avgLinkScore / avgRandomPairScore;

  return {
    avgLinkScore,
    avgRandomPairScore,
    signalToNoiseRatio,
    linkCount: allLinks.length,
    baselinePairCount: baselineCount,
  };
}

// --- 6. git hook capture rate / automation rate -------------------------------

const HOOK_PATH = nodePath.join(REPO_ROOT, ".coding-memory", "post-commit-hook.mjs");
const AUTOMATION_PROJECT = "coding-memory";

interface AutomationRateResult {
  totalMemories: number;
  autoCount: number;
  manualCount: number;
  automationRate: number;
  hookFound: boolean;
  capturedCategories: string[];
  gitLogAvailable: boolean;
}

function benchmarkAutomationRate(allMemories: MemoryRow[]): AutomationRateResult {
  const hookFound = nodeFs.existsSync(HOOK_PATH);
  const hookSource = hookFound ? nodeFs.readFileSync(HOOK_PATH, "utf-8") : "";
  const capturedCategories = HOOK_TEMPLATE_PREFIXES.filter((p) => hookSource.includes(p.prefix)).map(
    (p) => p.label
  );

  // The hook's 8th capture category — the raw commit message, saved as a
  // decision when it passes the quality filter — isn't a template, so it's
  // indistinguishable from a manual `cm save` by content shape alone. Cross
  // -reference this repo's real git history instead: if a decision's
  // content exactly matches a real commit message, it was hook-captured.
  let commitMessages = new Set<string>();
  let gitLogAvailable = true;
  try {
    const log = execSync("git log --pretty=%B%x00", { cwd: REPO_ROOT, encoding: "utf-8" });
    for (const message of log.split("\x00")) {
      const trimmed = message.trim();
      if (trimmed) commitMessages.add(trimmed);
    }
  } catch {
    gitLogAvailable = false;
  }

  const projectMemories = allMemories.filter((m) => m.project === AUTOMATION_PROJECT);

  let autoCount = 0;
  for (const memory of projectMemories) {
    const templateMatch = HOOK_TEMPLATE_PREFIXES.some((p) => memory.content.startsWith(p.prefix));
    const commitMatch = memory.type === "decision" && commitMessages.has(memory.content.trim());
    if (templateMatch || commitMatch) autoCount++;
  }

  return {
    totalMemories: projectMemories.length,
    autoCount,
    manualCount: projectMemories.length - autoCount,
    automationRate: projectMemories.length === 0 ? 0 : autoCount / projectMemories.length,
    hookFound,
    capturedCategories,
    gitLogAvailable,
  };
}

// --- report formatting ---------------------------------------------------

const DIVIDER = "═".repeat(63);

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function pad(label: string, width = 28): string {
  return label.padEnd(width);
}

function printHeader() {
  console.log(DIVIDER);
  console.log("STACKMEM BENCHMARK REPORT");
  console.log(DIVIDER);
  console.log("");
}

function printTable(headers: string[], rows: string[][]) {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i].length))
  );
  const border = (left: string, mid: string, right: string) =>
    left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;
  const formatRow = (cells: string[]) =>
    "│" + cells.map((cell, i) => ` ${cell.padEnd(widths[i])} `).join("│") + "│";

  console.log(border("┌", "┬", "┐"));
  console.log(formatRow(headers));
  console.log(border("├", "┼", "┤"));
  for (const row of rows) console.log(formatRow(row));
  console.log(border("└", "┴", "┘"));
}

const KEY_FACT_LABELS: Record<keyof KeyFactsCoverage, string> = {
  techStack: "tech stack",
  activeConstraints: "active constraints",
  recentDecisions: "recent decisions",
  knownFixes: "known fixes",
};

async function main() {
  const [allMemories, allLinks] = await Promise.all([fetchAllMemories(), fetchAllLinks()]);

  printHeader();

  // 0. Comparative baseline ----------------------------------------------------
  const baseline = benchmarkComparativeBaseline(allMemories);
  const subDivider = "   " + "─".repeat(43);
  console.log("0. COMPARATIVE BASELINE");
  console.log(subDivider);
  console.log("   Approach A (cold session):");
  console.log(`     ${pad("Tokens injected:", 20)}${baseline.approachA.tokens}`);
  console.log(`     ${pad("Context coverage:", 20)}${pct(baseline.approachA.coveragePct)}`);
  console.log("");
  console.log("   Approach B (full codebase dump):");
  console.log(`     ${pad("Files scanned:", 20)}${baseline.approachB.filesScanned}`);
  console.log(`     ${pad("Tokens required:", 20)}${baseline.approachB.totalTokens.toLocaleString()}`);
  console.log(`     ${pad("Context coverage:", 20)}~100% (structural)`);
  console.log("     Problem: exceeds context window for");
  console.log("              large projects, no semantic");
  console.log("              ranking, includes noise");
  console.log("");
  console.log("   Approach C (stackmem):");
  console.log(`     ${pad("Tokens injected:", 20)}${baseline.approachC.tokens.toLocaleString()}`);
  console.log(
    `     ${pad("Context coverage:", 20)}${pct(baseline.approachC.coveragePct)} (semantic) — ${
      baseline.approachC.factsCovered
    }/4 key facts`
  );
  const coveredFacts = Object.entries(baseline.approachC.coverage)
    .filter(([, covered]) => covered)
    .map(([key]) => KEY_FACT_LABELS[key as keyof KeyFactsCoverage]);
  const missingFacts = Object.entries(baseline.approachC.coverage)
    .filter(([, covered]) => !covered)
    .map(([key]) => KEY_FACT_LABELS[key as keyof KeyFactsCoverage]);
  console.log(`       covered: ${coveredFacts.length > 0 ? coveredFacts.join(", ") : "(none)"}`);
  console.log(`       missing: ${missingFacts.length > 0 ? missingFacts.join(", ") : "(none)"}`);
  const vsFullDump =
    baseline.approachB.totalTokens === 0
      ? 0
      : 1 - baseline.approachC.tokens / baseline.approachB.totalTokens;
  console.log(`     ${pad("vs full dump:", 20)}${pct(vsFullDump)} fewer tokens`);
  console.log(`     ${pad("vs cold session:", 20)}${baseline.approachC.factsCovered} facts injected`);
  console.log(subDivider);
  console.log("");

  // 1. Token efficiency ------------------------------------------------------
  const tokenResult = benchmarkTokenEfficiency(allMemories);
  console.log("1. TOKEN EFFICIENCY");
  for (const row of tokenResult.perProject) {
    const saved = row.rawTokens === 0 ? 0 : 1 - row.injectedTokens / row.rawTokens;
    console.log(
      `   ${pad(row.project, 20)} raw ${row.rawTokens.toLocaleString().padStart(6)}   injected ${row.injectedTokens
        .toLocaleString()
        .padStart(6)}   saved ${pct(saved)}`
    );
  }
  console.log("");
  const reductionRatio = tokenResult.totalInjected === 0 ? 0 : tokenResult.totalRaw / tokenResult.totalInjected;
  const tokenSavings = tokenResult.totalRaw === 0 ? 0 : 1 - tokenResult.totalInjected / tokenResult.totalRaw;
  console.log(`   ${pad("Raw tokens (no budget):")}${tokenResult.totalRaw.toLocaleString()}`);
  console.log(`   ${pad("Injected tokens (budgeted):")}${tokenResult.totalInjected.toLocaleString()}`);
  console.log(`   ${pad("Reduction ratio:")}${reductionRatio.toFixed(2)}x`);
  console.log(`   ${pad("Token savings:")}${pct(tokenSavings)}`);
  if (tokenSavings === 0) {
    console.log(
      "   (0% because every project's unresolved memories currently fit under"
    );
    console.log(
      "    the 2000-token budget on their own — the cap hasn't had to bind yet."
    );
    console.log("    It will show real savings once a project accumulates enough");
    console.log("    live memories to exceed the budget.)");
  }
  console.log("");

  // 2. Context relevance ------------------------------------------------------
  const relevanceResult = benchmarkContextRelevance(allMemories);
  console.log("2. CONTEXT RELEVANCE (Precision@5)");
  relevanceResult.results.forEach((r, i) => {
    console.log(`   Task ${i + 1}: ${r.hits}/5 relevant (${pct(r.precisionAt5)}) — "${r.task}"`);
  });
  console.log("");
  console.log(`   ${pad("Average Precision@5:")}${pct(relevanceResult.average)}`);
  const avgPrecisionAt1 =
    relevanceResult.results.reduce((sum, r) => sum + r.precisionAt1, 0) / relevanceResult.results.length;
  console.log(`   ${pad("Average Precision@1:")}${pct(avgPrecisionAt1)}`);
  console.log(
    "   (note: with only ~13 live memories, most tasks have at most one truly"
  );
  console.log(
    "    relevant match, so the top-ranked result is usually right even when"
  );
  console.log("    padding ranks 2-5 with unrelated memories drags Precision@5 down.)");
  console.log("");

  // Shared sample for sections 3 and 4.
  const unrelatedPairs = seededShuffle(generateAllPairs(allMemories), BENCHMARK_SEED).slice(0, SAMPLE_SIZE);

  // 3. Duplicate detection ------------------------------------------------------
  const dupResult = benchmarkDuplicateDetection(allMemories, unrelatedPairs);
  console.log("3. DUPLICATE DETECTION");
  console.log(`   TP: ${dupResult.tp}  FP: ${dupResult.fp}  TN: ${dupResult.tn}  FN: ${dupResult.fn}`);
  console.log(`   ${pad("Precision:")}${pct(dupResult.precision)}`);
  console.log(`   ${pad("Recall:")}${pct(dupResult.recall)}`);
  console.log(`   ${pad("F1 Score:")}${pct(dupResult.f1)}`);
  if (dupResult.fn > 0) {
    console.log(`   FN breakdown (${dupResult.fn} missed self-duplicates):`);
    console.log(
      `     ${dupResult.fnViaNegationCarveout} via negation-word carve-out (content like "removed dependency: X" reads as superseding itself)`
    );
    console.log(
      `     ${dupResult.fnViaNoExtractableEntities} via no extractable entities (content under the 5-char entity minimum, e.g. "wip")`
    );
  }
  console.log("");

  // 4. Contradiction detection ------------------------------------------------
  const contradictionResult = benchmarkContradictionDetection(allMemories, unrelatedPairs);
  console.log("4. CONTRADICTION DETECTION");
  console.log(
    `   TP: ${contradictionResult.tp}  FP: ${contradictionResult.fp}  TN: ${contradictionResult.tn}  FN: ${contradictionResult.fn}`
  );
  console.log(`   ${pad("Precision:")}${pct(contradictionResult.precision)}`);
  console.log(`   ${pad("Recall:")}${pct(contradictionResult.recall)}`);
  console.log(`   ${pad("F1 Score:")}${pct(contradictionResult.f1)}`);
  if (contradictionResult.fp > 0) {
    console.log(`   FP breakdown (${contradictionResult.fp} unrelated pairs flagged as contradictions):`);
    console.log(
      `     ${contradictionResult.fpViaTemplateCollision} via template collision (both share a hook-generated prefix like "removed dependency: X", so shared template words alone cross the contradiction threshold)`
    );
  }
  console.log("");

  // 5. Semantic linking quality -------------------------------------------------
  const linkingResult = benchmarkSemanticLinking(allMemories, allLinks);
  console.log("5. SEMANTIC LINKING QUALITY");
  console.log(
    `   ${pad("Avg link score:")}${linkingResult.avgLinkScore.toFixed(2)}  (n=${linkingResult.linkCount})`
  );
  console.log(
    `   ${pad("Avg random pair score:")}${linkingResult.avgRandomPairScore.toFixed(2)}  (n=${linkingResult.baselinePairCount})`
  );
  console.log(
    `   ${pad("Signal-to-noise ratio:")}${
      Number.isFinite(linkingResult.signalToNoiseRatio) ? `${linkingResult.signalToNoiseRatio.toFixed(1)}x` : "∞"
    }`
  );
  console.log("");

  // 6. Automation rate ----------------------------------------------------------
  const automationResult = benchmarkAutomationRate(allMemories);
  console.log("6. AUTOMATION RATE");
  if (automationResult.hookFound) {
    console.log(`   Hook captures ${automationResult.capturedCategories.length} categories:`);
    for (const label of automationResult.capturedCategories) {
      console.log(`     - ${label}`);
    }
    console.log("     - raw commit message → decision (quality-filtered)");
  } else {
    console.log(`   (hook file not found at ${HOOK_PATH} — category list unavailable)`);
  }
  if (!automationResult.gitLogAvailable) {
    console.log("   (git log unavailable — commit-message decisions counted as manual)");
  }
  console.log("");
  console.log(
    `   ${pad("Auto-captured memories:")}${pct(automationResult.automationRate)}  (${automationResult.autoCount}/${automationResult.totalMemories})`
  );
  console.log(
    `   ${pad("Manually saved memories:")}${pct(1 - automationResult.automationRate)}  (${automationResult.manualCount}/${automationResult.totalMemories})`
  );
  console.log("");

  // Head-to-head comparison -----------------------------------------------
  console.log("APPROACH COMPARISON");
  printTable(
    ["", "Cold", "Full dump", "stackmem"],
    [
      [
        "Tokens used",
        baseline.approachA.tokens.toLocaleString(),
        baseline.approachB.totalTokens.toLocaleString(),
        baseline.approachC.tokens.toLocaleString(),
      ],
      ["Key facts", "0", "~all", pct(baseline.approachC.coveragePct)],
      ["Stale content", "N/A", "possible", "auto-updated"],
      ["Setup required", "none", "manual", "cm init"],
    ]
  );
  console.log("");

  console.log(DIVIDER);
}

main().catch((error) => {
  console.error("Benchmark failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
