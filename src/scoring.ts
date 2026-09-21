// --- semantic linking ------------------------------------------------------

const STOP_WORDS = new Set([
  "we", "use", "for", "all", "a", "the", "is", "has", "have", "are", "to",
  "of", "in", "it", "this", "that", "with", "and", "or", "but",
]);

const MIN_ENTITY_LENGTH = 5;

// Key entities: words longer than 4 characters that aren't stop words.
// Short/common words carry little identifying signal for a memory.
export function extractEntities(text: string): Set<string> {
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
  const newEntities = extractEntities(newContent);
  return existingMemories
    .map((existing) => ({
      source_id: newMemoryId,
      target_id: existing.id,
      score: containmentScore(newEntities, extractEntities(existing.content)),
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
  const newEntities = extractEntities(newContent);
  const hasNegation = containsNegationWord(newContent);

  let bestDuplicate: { id: string; score: number } | null = null;
  let bestSupersede: { id: string; score: number } | null = null;

  for (const existing of existingMemories) {
    const score = containmentScore(newEntities, extractEntities(existing.content));

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
