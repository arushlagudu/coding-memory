// Unit tests for the hybrid scoring functions in src/scoring.ts. Pure
// functions only — no network, no Supabase — using Node's built-in test
// runner (no Jest). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  containmentScore,
  containsNegationWord,
  decideSaveAction,
  computeDecayScore,
  extractEntities,
  hybridScore,
  ngramOverlap,
  redactSecrets,
} from "../scoring.js";

// 1. containment(a,b) returns 1.0 for identical strings.
test("containmentScore returns 1.0 for identical strings", () => {
  const entities = extractEntities("implement stripe webhook signature verification");
  assert.equal(containmentScore(entities, entities), 1);
});

// 2. containment(a,b) returns 0.0 for disjoint strings.
test("containmentScore returns 0.0 for entity-disjoint strings", () => {
  const a = extractEntities("implement stripe webhook signature verification");
  const b = extractEntities("migrate postgres database connection pooling");
  assert.equal(containmentScore(a, b), 0);
});

// 3. trigramJaccard (ngramOverlap) returns a value between 0 and 1.
test("ngramOverlap (character-trigram Jaccard) returns a value between 0 and 1", () => {
  const overlapping = ngramOverlap("hello world", "hello there");
  const identical = ngramOverlap("hello world", "hello world");
  const disjoint = ngramOverlap("abc", "xyz123qwerty");

  for (const score of [overlapping, identical, disjoint]) {
    assert.ok(score >= 0 && score <= 1, `expected ${score} to be within [0, 1]`);
  }
  assert.equal(identical, 1);
});

// 4. hybridScore = 0.7*containment + 0.3*trigram.
test("hybridScore combines containment and trigram overlap with 0.7/0.3 weights", () => {
  const a = "implement stripe webhook signature verification logic";
  const b = "add stripe webhook handler with signature checks";

  const containment = containmentScore(extractEntities(a), extractEntities(b));
  const trigram = ngramOverlap(a, b);
  const expected = containment * 0.7 + trigram * 0.3;

  assert.ok(Math.abs(hybridScore(a, b) - expected) < 1e-9);
});

// 5. isDuplicate (decideSaveAction's "duplicate" branch) fires when
// hybridScore exceeds the 0.85 threshold.
test('decideSaveAction returns "duplicate" when content scores above 0.85 against an existing memory', () => {
  const existing = [{ id: "mem-1", content: "implement stripe webhook signature verification logic" }];
  const decision = decideSaveAction("implement stripe webhook signature verification logic", existing);
  assert.equal(decision.action, "duplicate");
});

// 6. isContradiction: negation-word detection, and decideSaveAction's
// "superseded" branch when a negation word pairs with enough overlap.
test("containsNegationWord detects negation/contradiction language", () => {
  assert.equal(containsNegationWord("we switched from REST to GraphQL"), true);
  assert.equal(containsNegationWord("no longer using the old queue"), true);
  assert.equal(containsNegationWord("a totally unrelated sentence about cats"), false);
});

test('decideSaveAction returns "superseded" when new content contradicts an existing memory', () => {
  const existing = [{ id: "mem-1", content: "use rest api for payment webhook processing" }];
  const decision = decideSaveAction(
    "we switched from rest api to graphql for payment webhook processing",
    existing
  );
  assert.equal(decision.action, "superseded");
});

// 7. computeDecayScore returns a higher score for more recently created
// memories (same access count).
test("computeDecayScore returns a higher score for more recently created memories", () => {
  const recent = computeDecayScore(new Date(Date.now() - 1000), 0);
  const old = computeDecayScore(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), 0);
  assert.ok(recent > old);
});

// 8. computeDecayScore returns a higher score for more frequently
// accessed memories (same creation time).
test("computeDecayScore returns a higher score for more frequently accessed memories", () => {
  const createdAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  const lowAccess = computeDecayScore(createdAt, 0);
  const highAccess = computeDecayScore(createdAt, 50);
  assert.ok(highAccess > lowAccess);
});

// 9. Pinned memories always get score 999, regardless of age or access
// count.
test("computeDecayScore returns 999 for pinned memories regardless of age or access count", () => {
  assert.equal(computeDecayScore(new Date(0), 0, true), 999);
  assert.equal(computeDecayScore(new Date(), 10_000, true), 999);
  assert.equal(computeDecayScore(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000), 0, true), 999);
});

// 10. redactSecrets catches all 5 documented pattern types.
test("redactSecrets catches AWS keys, API keys, bearer tokens, private keys, and .env lines", () => {
  assert.doesNotMatch(redactSecrets("deployed with AKIAABCDEFGHIJ123456 in prod"), /AKIA[0-9A-Z]{16}/);
  assert.match(redactSecrets("deployed with AKIAABCDEFGHIJ123456 in prod"), /\[REDACTED\]/);

  assert.match(redactSecrets("api_key: abcdefghijklmnopqrstuvwxyz1234567890"), /\[REDACTED\]/);

  assert.match(
    redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature"),
    /\[REDACTED\]/
  );

  assert.match(
    redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJ...\n-----END RSA PRIVATE KEY-----"),
    /\[REDACTED\]/
  );

  assert.match(redactSecrets("DATABASE_URL=postgres://user:pass@host:5432/db"), /\[REDACTED\]/);
});
