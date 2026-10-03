// --- semantic linking ------------------------------------------------------
const STOP_WORDS = new Set([
    "we", "use", "for", "all", "a", "the", "is", "has", "have", "are", "to",
    "of", "in", "it", "this", "that", "with", "and", "or", "but",
]);
const MIN_ENTITY_LENGTH = 5;
// Key entities: words longer than 4 characters that aren't stop words.
// Short/common words carry little identifying signal for a memory.
export function extractEntities(text) {
    const entities = new Set();
    for (const word of text.toLowerCase().split(/\W+/)) {
        if (word.length < MIN_ENTITY_LENGTH || STOP_WORDS.has(word))
            continue;
        entities.add(word);
    }
    return entities;
}
// Containment score: shared entities over the SMALLER of the two entity
// sets, so a short memory whose terms are fully covered by a longer one
// still scores highly — unlike Jaccard, which penalizes size mismatches.
export function containmentScore(entitiesA, entitiesB) {
    const smallerSize = Math.min(entitiesA.size, entitiesB.size);
    if (smallerSize === 0)
        return 0;
    let shared = 0;
    for (const entity of entitiesA) {
        if (entitiesB.has(entity))
            shared += 1;
    }
    return shared / smallerSize;
}
export function computeMemoryLinks(newMemoryId, newContent, existingMemories, threshold = 0.15) {
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
function containsNegationWord(text) {
    const lower = text.toLowerCase();
    return NEGATION_WORDS.some((word) => lower.includes(word));
}
// Decides whether a new memory is a near-duplicate of an existing one
// (skip it), supersedes an existing one (resolve the old, insert the new),
// or is genuinely new. A negation word (e.g. "switched", "no longer")
// reroutes an otherwise-duplicate-level score into a supersede instead —
// without that carve-out, a "switched from X to Y" memory that repeats X's
// keywords would score as a duplicate of the memory it's meant to replace.
// Scanning finds the best-scoring match in each band rather than stopping
// at the first hit, so the result doesn't depend on row order.
export function decideSaveAction(newContent, existingMemories) {
    const newEntities = extractEntities(newContent);
    const hasNegation = containsNegationWord(newContent);
    let bestDuplicate = null;
    let bestSupersede = null;
    for (const existing of existingMemories) {
        const score = containmentScore(newEntities, extractEntities(existing.content));
        if (score > DUPLICATE_THRESHOLD) {
            if (hasNegation) {
                if (!bestSupersede || score > bestSupersede.score) {
                    bestSupersede = { id: existing.id, score };
                }
            }
            else if (!bestDuplicate || score > bestDuplicate.score) {
                bestDuplicate = { id: existing.id, score };
            }
        }
        else if (hasNegation && score >= CONTRADICTION_MIN) {
            if (!bestSupersede || score > bestSupersede.score) {
                bestSupersede = { id: existing.id, score };
            }
        }
    }
    if (bestDuplicate)
        return { action: "duplicate", matchedId: bestDuplicate.id };
    if (bestSupersede)
        return { action: "superseded", oldId: bestSupersede.id };
    return { action: "created" };
}
// --- memory decay --------------------------------------------------------
// Decay constant tuned for a ~14-day half-life: exp(-0.05 * 14) ≈ 0.5.
const DECAY_LAMBDA = 0.05;
// Recency-weighted relevance: frequently-accessed memories decay slower,
// but every memory still fades over time regardless of access count.
export function computeDecayScore(createdAt, accessCount) {
    const daysSinceCreated = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
    return (1 + Math.log(1 + accessCount)) * Math.exp(-DECAY_LAMBDA * daysSinceCreated);
}
// --- context budget ------------------------------------------------------
// Rough token estimate: ~4 characters per token.
export function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
// Takes a decay-sorted memory array (highest relevance first) and keeps
// adding memories until the next one would push the running token count
// over budget, so what gets injected into an agent's context stays capped.
export function applyContextBudget(memories, budgetTokens) {
    const result = [];
    let usedTokens = 0;
    for (const memory of memories) {
        const tokens = estimateTokens(memory.content);
        if (usedTokens + tokens > budgetTokens)
            break;
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
export function clusterMemories(memories) {
    const parent = memories.map((_, index) => index);
    function find(index) {
        while (parent[index] !== index) {
            parent[index] = parent[parent[index]];
            index = parent[index];
        }
        return index;
    }
    function union(a, b) {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB)
            parent[rootA] = rootB;
    }
    const entities = memories.map((memory) => extractEntities(memory.content));
    for (let i = 0; i < memories.length; i++) {
        for (let j = i + 1; j < memories.length; j++) {
            if (containmentScore(entities[i], entities[j]) > CLUSTER_THRESHOLD) {
                union(i, j);
            }
        }
    }
    const clustersByRoot = new Map();
    for (let i = 0; i < memories.length; i++) {
        const root = find(i);
        if (!clustersByRoot.has(root))
            clustersByRoot.set(root, []);
        clustersByRoot.get(root).push(memories[i]);
    }
    return Array.from(clustersByRoot.values());
}
const SUMMARY_ITEM_LENGTH = 60;
// Builds a compact summary for a cluster of related memories: the most
// common type in the cluster, the most frequent shared entity as the
// "topic", and each memory's content truncated and joined.
export function buildSummaryContent(cluster) {
    const typeCounts = new Map();
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
    const entityCounts = new Map();
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
export function isQualityMessage(message) {
    const trimmed = message.trim();
    if (trimmed.length < 15)
        return false;
    if (SEMVER_RE.test(trimmed))
        return false;
    if (!trimmed.includes(" "))
        return false;
    const stripped = trimmed.replace(/\s/g, "");
    if (stripped.length > 0 && new Set(stripped).size === 1)
        return false;
    const lowerTrimmed = trimmed.toLowerCase();
    if (LOW_QUALITY_PREFIXES.includes(lowerTrimmed))
        return false;
    const firstWord = (lowerTrimmed.match(/^[a-z0-9]+/) || [""])[0];
    if (LOW_QUALITY_PREFIXES.includes(firstWord))
        return false;
    return true;
}
// --- session-end classification ---------------------------------------------
const FAILURE_PHRASES = ["failed", "didn't work", "reverted", "switched away"];
export function indicatesFailedApproach(text) {
    const lower = text.toLowerCase();
    return FAILURE_PHRASES.some((phrase) => lower.includes(phrase));
}
export function isAuthRelatedFile(filePath) {
    return /(auth|login|session|token)/i.test(filePath);
}
export function isCodeFile(filePath) {
    return /\.(ts|js)$/i.test(filePath);
}
// --- task relevance --------------------------------------------------------
function splitWords(text) {
    return text
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.length > 0 && !STOP_WORDS.has(word));
}
// Blends entity containment (structural overlap) with raw word overlap
// (surface-level phrasing match) so a memory that shares the task's exact
// wording scores well even if its extracted entities don't line up neatly.
export function scoreMemoryRelevance(memoryContent, task) {
    const containment = containmentScore(extractEntities(memoryContent), extractEntities(task));
    const memoryWords = new Set(splitWords(memoryContent));
    const taskWords = splitWords(task);
    let shared = 0;
    for (const word of taskWords) {
        if (memoryWords.has(word))
            shared++;
    }
    const wordOverlapRatio = taskWords.length === 0 ? 0 : shared / taskWords.length;
    return containment * 0.7 + wordOverlapRatio * 0.3;
}
// TODO: optimize the clustering algorithm
