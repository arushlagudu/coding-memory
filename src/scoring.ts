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
