// --- semantic linking ------------------------------------------------------

const STOP_WORDS = new Set([
  "we", "use", "for", "all", "a", "the", "is", "has", "have", "are", "to",
  "of", "in", "it", "this", "that", "with", "and", "or", "but",
]);

// Bumping this from 5 to 6 was considered (see the benchmark's duplicate-
// detection findings) but doesn't actually fix anything: "removed" is 7
// chars and "added"/"dependency" aren't the problem either. The real issue
// is entity-level, not length-based — see DEPENDENCY_TEMPLATE_RE below.
const MIN_ENTITY_LENGTH = 5;

// Hook-generated dependency-change templates ("removed dependency: X" /
// "added dependency: X") reduce to just {"removed"/"added", "dependency"}
// under generic word-based extraction below, since package names are often
// short (node:path, zod, ./device.js — all filtered by MIN_ENTITY_LENGTH).
// That made two DIFFERENT packages removed in different commits look like
// duplicates of each other. Special-cased here instead: for these
// templates, the package name itself is the only entity, so containment
// (and hybridScore) only agrees when the package name actually matches.
const DEPENDENCY_TEMPLATE_RE = /^(removed|added) dependency:/i;
const DEPENDENCY_PACKAGE_RE = /^(?:removed|added) dependency:\s*(.+)$/i;

function extractDependencyPackageName(content: string): string | null {
  const match = DEPENDENCY_PACKAGE_RE.exec(content.trim());
  return match ? match[1].trim().toLowerCase() : null;
}

// Key entities: words longer than 4 characters that aren't stop words.
// Short/common words carry little identifying signal for a memory.
export function extractEntities(text: string): Set<string> {
  const packageName = extractDependencyPackageName(text);
  if (packageName !== null) return new Set([packageName]);

  const entities = new Set<string>();
  for (const word of text.toLowerCase().split(/\W+/)) {
    if (word.length < MIN_ENTITY_LENGTH || STOP_WORDS.has(word)) continue;
    entities.add(word);
  }
  return entities;
}

// Containment score: shared entities over the SMALLER of the two entity
// sets, so a short memory whose terms are fully covered by a longer one
// still scores highly — unlike Jaccard, which penalizes size mismatches.
export function containmentScore(entitiesA: Set<string>, entitiesB: Set<string>): number {
  const smallerSize = Math.min(entitiesA.size, entitiesB.size);
  if (smallerSize === 0) return 0;

  let shared = 0;
  for (const entity of entitiesA) {
    if (entitiesB.has(entity)) shared += 1;
  }

  return shared / smallerSize;
}

function trigramSet(text: string): Set<string> {
  const normalized = text.toLowerCase();
  if (normalized.length < 3) {
    return normalized.length > 0 ? new Set([normalized]) : new Set();
  }

  const trigrams = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    trigrams.add(normalized.slice(i, i + 3));
  }
  return trigrams;
}

// Character-trigram Jaccard overlap: catches surface-level lexical
// similarity (typos, partial substrings, shared phrasing) that word-based
// containment misses entirely, since containment only ever compares whole
// extracted entities.
function ngramOverlap(a: string, b: string): number {
  const trigramsA = trigramSet(a);
  const trigramsB = trigramSet(b);
  const union = new Set([...trigramsA, ...trigramsB]);
  if (union.size === 0) return 0;

  let shared = 0;
  for (const trigram of trigramsA) {
    if (trigramsB.has(trigram)) shared++;
  }
  return shared / union.size;
}

// Blends entity containment (structural: do the two texts share key
// extracted terms) with character-trigram overlap (lexical: do the two
// texts look alike as raw strings) so near-duplicates with slightly
// different wording still score high even when their extracted entities
// don't line up neatly, and vice versa.
//
// NOTE ON THRESHOLDS: DUPLICATE_THRESHOLD (0.85), CONTRADICTION_MIN (0.4),
// computeMemoryLinks' default (0.15), and CLUSTER_THRESHOLD (0.2) were all
// tuned against pure containmentScore. The 0.3 trigram component shifts
// scores upward for almost any pair sharing common substrings (whitespace,
// "ing", "the", etc.), so these thresholds may need recalibration —
// re-validate against src/benchmark.ts rather than assuming they still
// hold as-is.
export function hybridScore(a: string, b: string): number {
  const containment = containmentScore(extractEntities(a), extractEntities(b));
  const overlap = ngramOverlap(a, b);
  return containment * 0.7 + overlap * 0.3;
}

// --- memory links ------------------------------------------------------

export interface ExistingMemory {
  id: string;
  content: string;
}

export interface MemoryLink {
  source_id: string;
  target_id: string;
  score: number;
}

export function computeMemoryLinks(
  newMemoryId: string,
  newContent: string,
  existingMemories: ExistingMemory[],
  threshold = 0.15
): MemoryLink[] {
  return existingMemories
    .map((existing) => ({
      source_id: newMemoryId,
      target_id: existing.id,
      score: hybridScore(newContent, existing.content),
    }))
    .filter((link) => link.score > threshold);
}

// --- save-memory CRUD decision ------------------------------------------

const DUPLICATE_THRESHOLD = 0.85;
const CONTRADICTION_MIN = 0.4;

// Words that signal the new memory is meant to replace an old one rather
// than just relate to it (e.g. "we switched from X to Y").
const NEGATION_WORDS = [
  "switched", "removed", "replaced", "no longer", "instead",
  "deprecated", "reverted", "changed",
];

function containsNegationWord(text: string): boolean {
  const lower = text.toLowerCase();
  return NEGATION_WORDS.some((word) => lower.includes(word));
}

export type SaveAction =
  | { action: "duplicate"; matchedId: string }
  | { action: "superseded"; oldId: string }
  | { action: "created" };

// Decides whether a new memory is a near-duplicate of an existing one
// (skip it), supersedes an existing one (resolve the old, insert the new),
// or is genuinely new. A negation word (e.g. "switched", "no longer")
// reroutes an otherwise-duplicate-level score into a supersede instead —
// without that carve-out, a "switched from X to Y" memory that repeats X's
// keywords would score as a duplicate of the memory it's meant to replace.
// Scanning finds the best-scoring match in each band rather than stopping
// at the first hit, so the result doesn't depend on row order.
export function decideSaveAction(
  newContent: string,
  existingMemories: ExistingMemory[]
): SaveAction {
  // Dependency-change templates are structural facts, not decisions —
  // "removed"/"added" would otherwise trip containsNegationWord below, but
  // there's nothing for them to supersede/contradict, so they're exempted
  // up front and only ever fall through to the plain duplicate check.
  const hasNegation = DEPENDENCY_TEMPLATE_RE.test(newContent) ? false : containsNegationWord(newContent);

  let bestDuplicate: { id: string; score: number } | null = null;
  let bestSupersede: { id: string; score: number } | null = null;

  for (const existing of existingMemories) {
    const score = hybridScore(newContent, existing.content);

    if (score > DUPLICATE_THRESHOLD) {
      if (hasNegation) {
        if (!bestSupersede || score > bestSupersede.score) {
          bestSupersede = { id: existing.id, score };
        }
      } else if (!bestDuplicate || score > bestDuplicate.score) {
        bestDuplicate = { id: existing.id, score };
      }
    } else if (hasNegation && score >= CONTRADICTION_MIN) {
      if (!bestSupersede || score > bestSupersede.score) {
        bestSupersede = { id: existing.id, score };
      }
    }
  }

  if (bestDuplicate) return { action: "duplicate", matchedId: bestDuplicate.id };
  if (bestSupersede) return { action: "superseded", oldId: bestSupersede.id };
  return { action: "created" };
}

// --- memory decay --------------------------------------------------------

// Decay constant tuned for a ~14-day half-life: exp(-0.05 * 14) ≈ 0.5.
// Overridable per-project via .stackmem.json's decayLambda (src/config-file.ts).
export const DEFAULT_DECAY_LAMBDA = 0.05;

// A pinned memory always sorts first and never decays — 999 is well above
// any value the exponential formula below can produce, so ranking by this
// score alone puts every pinned memory ahead of every unpinned one.
const PINNED_SCORE = 999;

// Recency-weighted relevance: frequently-accessed memories decay slower,
// but every memory still fades over time regardless of access count —
// unless pinned.
export function computeDecayScore(
  createdAt: Date,
  accessCount: number,
  pinned = false,
  lambda = DEFAULT_DECAY_LAMBDA
): number {
  if (pinned) return PINNED_SCORE;

  const daysSinceCreated = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
  return (1 + Math.log(1 + accessCount)) * Math.exp(-lambda * daysSinceCreated);
}

// --- context budget ------------------------------------------------------

// Rough token estimate: ~4 characters per token.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Takes a decay-sorted memory array (highest relevance first) and keeps
// adding memories until the next one would push the running token count
// over budget, so what gets injected into an agent's context stays capped.
export function applyContextBudget(memories: any[], budgetTokens: number): any[] {
  const result: any[] = [];
  let usedTokens = 0;

  for (const memory of memories) {
    const tokens = estimateTokens(memory.content);
    if (usedTokens + tokens > budgetTokens) break;
    result.push(memory);
    usedTokens += tokens;
  }

  return result;
}

// --- memory compression --------------------------------------------------

const CLUSTER_THRESHOLD = 0.2;

// Single-linkage clustering over containment score: two memories join the
// same cluster if they score > 0.2, and clusters merge transitively (via
// union-find) even if the two memories that join them don't directly score
// above the threshold themselves.
export function clusterMemories(memories: any[]): any[][] {
  const parent = memories.map((_, index) => index);

  function find(index: number): number {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  }

  function union(a: number, b: number) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootA] = rootB;
  }

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      if (hybridScore(memories[i].content, memories[j].content) > CLUSTER_THRESHOLD) {
        union(i, j);
      }
    }
  }

  const clustersByRoot = new Map<number, any[]>();
  for (let i = 0; i < memories.length; i++) {
    const root = find(i);
    if (!clustersByRoot.has(root)) clustersByRoot.set(root, []);
    clustersByRoot.get(root)!.push(memories[i]);
  }

  return Array.from(clustersByRoot.values());
}

const SUMMARY_ITEM_LENGTH = 60;

// Builds a compact summary for a cluster of related memories: the most
// common type in the cluster, the most frequent shared entity as the
// "topic", and each memory's content truncated and joined.
export function buildSummaryContent(cluster: any[]): string {
  const typeCounts = new Map<string, number>();
  for (const memory of cluster) {
    typeCounts.set(memory.type, (typeCounts.get(memory.type) ?? 0) + 1);
  }
  let mostCommonType = cluster[0]?.type ?? "discovery";
  let maxTypeCount = 0;
  for (const [type, count] of typeCounts) {
    if (count > maxTypeCount) {
      maxTypeCount = count;
      mostCommonType = type;
    }
  }

  const entityCounts = new Map<string, number>();
  for (const memory of cluster) {
    for (const entity of extractEntities(memory.content)) {
      entityCounts.set(entity, (entityCounts.get(entity) ?? 0) + 1);
    }
  }
  let topic = "general";
  let maxEntityCount = 0;
  for (const [entity, count] of entityCounts) {
    if (count > maxEntityCount) {
      maxEntityCount = count;
      topic = entity;
    }
  }

  const items = cluster
    .map((memory) => memory.content.slice(0, SUMMARY_ITEM_LENGTH))
    .join("; ");

  return `[${mostCommonType.toUpperCase()} cluster] ${topic}: ${items}`;
}

// --- message quality filter ------------------------------------------------

const LOW_QUALITY_PREFIXES = [
  "wip", "fix", "update", "misc", "temp", "test", "patch", "minor",
  "tweak", "change", "stuff", "done", "commit", "save", "ok", "m", "x",
];

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

// Filters out lazy/placeholder messages ("wip", "fix", "m", "...") and bare
// version bumps ("1.0.4"). Checked against the first word (and the whole
// message), not a raw prefix match, so a real message like "Migrate auth to
// JWT" isn't rejected just for starting with the letter "m". The git hook
// keeps its own inline copy of this same logic since it runs as a standalone
// script with no access to this module — keep the two in sync by hand if
// this changes.
export function isQualityMessage(message: string): boolean {
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

// --- conventional commit routing --------------------------------------------

// Canonical reference implementation of the hook's conventional-commit
// routing — the git hook (src/cli.ts buildHookLogicScript) keeps its own
// inline copy since it runs standalone with no access to this module (same
// reason isQualityMessage above is duplicated there). Keep the two in sync
// by hand if this changes.
const CONVENTIONAL_COMMIT_RE = /^([a-zA-Z]+)(\([^)]*\))?!?:\s*(.+)/;
const CONVENTIONAL_DECISION_TYPES = new Set(["feat", "fix", "perf", "refactor"]);
const CONVENTIONAL_SKIP_TYPES = new Set(["docs", "style", "test", "ci", "build", "chore"]);

export type ConventionalCommitRoute = "decision" | "skip" | null;

// Classifies a commit's SUBJECT line only — "decision" for feat/fix/perf/
// refactor, "skip" for docs/style/test/ci/build/chore, or null if the
// subject doesn't start with a recognized conventional-commit type (in
// which case the caller falls back to isQualityMessage).
export function classifyConventionalCommit(message: string): ConventionalCommitRoute {
  const firstLine = message.trim().split("\n")[0];
  const match = firstLine.match(CONVENTIONAL_COMMIT_RE);
  if (!match) return null;

  const type = match[1].toLowerCase();
  if (CONVENTIONAL_DECISION_TYPES.has(type)) return "decision";
  if (CONVENTIONAL_SKIP_TYPES.has(type)) return "skip";
  return null;
}

// Whether the commit message's footer declares a breaking change — this
// check is independent of (and additive to) classifyConventionalCommit's
// type-based routing above.
export function hasBreakingChangeFooter(message: string): boolean {
  return /BREAKING CHANGE:\s*[\s\S]+/.test(message.trim());
}

// --- session-end classification ---------------------------------------------

const FAILURE_PHRASES = ["failed", "didn't work", "reverted", "switched away"];

export function indicatesFailedApproach(text: string): boolean {
  const lower = text.toLowerCase();
  return FAILURE_PHRASES.some((phrase) => lower.includes(phrase));
}

export function isAuthRelatedFile(filePath: string): boolean {
  return /(auth|login|session|token)/i.test(filePath);
}

// --- secret redaction ----------------------------------------------------

// Patterns whose entire match is replaced outright — each one is specific
// enough (AWS key prefix, a labeled api_key field, a Bearer auth header, a
// PEM private key header, a KEY=value .env line) that a false positive is
// unlikely enough to risk leaving the value in place.
const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /(api[_-]?key|apikey)\s*[:=]\s*["']?[\w-]{20,}["']?/gi,
  /bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/g,
  /^[A-Z_]+=.{8,}/gm,
];

// A bare 40+ char base64-ish string is common enough in non-secret content
// (hashes, ids) that it needs a second signal before redacting: Shannon
// entropy per character. Random secrets sit well above ~4.5 bits/char;
// lower-entropy lookalikes (repeated or structured text) are left alone.
const HIGH_ENTROPY_RE = /[a-zA-Z0-9+/]{40,}={0,2}/g;
const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 4.5;

function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;

  const counts = new Map<string, number>();
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

// Strips likely secrets (AWS keys, API keys, bearer tokens, private key
// headers, .env assignments, and high-entropy strings) before content is
// saved anywhere — a memory, a fix, or the hook's own printed summary.
export function redactSecrets(content: string): string {
  let result = content;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }

  result = result.replace(HIGH_ENTROPY_RE, (match) =>
    shannonEntropy(match) > HIGH_ENTROPY_MIN_BITS_PER_CHAR ? "[REDACTED]" : match
  );

  return result;
}

export function isCodeFile(filePath: string): boolean {
  return /\.(ts|js)$/i.test(filePath);
}

// --- task relevance --------------------------------------------------------

function splitWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word));
}

// Blends hybrid structural/lexical overlap (see hybridScore) with raw word
// overlap (surface-level phrasing match) so a memory that shares the task's
// exact wording scores well even if its extracted entities don't line up
// neatly.
export function scoreMemoryRelevance(memoryContent: string, task: string): number {
  const structuralScore = hybridScore(memoryContent, task);

  const memoryWords = new Set(splitWords(memoryContent));
  const taskWords = splitWords(task);

  let shared = 0;
  for (const word of taskWords) {
    if (memoryWords.has(word)) shared++;
  }
  const wordOverlapRatio = taskWords.length === 0 ? 0 : shared / taskWords.length;

  return structuralScore * 0.7 + wordOverlapRatio * 0.3;
}

// --- task-aware ranking signals (branch name / PR title overlap) -----------

const TOKEN_SPLIT_RE = /[^a-zA-Z0-9]+/;
const MIN_TOKEN_LENGTH = 3;

// Branch names and PR titles use "/", "-", "_" as word separators (e.g.
// "feature/stripe-webhook-retry"), unlike prose content — splitWords above
// only splits on whitespace, so it can't tokenize these the same way.
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of text.toLowerCase().split(TOKEN_SPLIT_RE)) {
    if (word.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(word)) {
      tokens.add(word);
    }
  }
  return tokens;
}

export function hasTokenOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const token of a) {
    if (b.has(token)) return true;
  }
  return false;
}

// TODO: optimize the clustering algorithm
