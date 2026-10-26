// CRUD-behavior tests. Tests 1-3 are pure (decideSaveAction, no network).
// Tests 4-6 exercise the real Supabase backend via the compiled CLI,
// matching src/tests/regression.test.ts's convention — using a dedicated
// throwaway project cleaned up in `after()` regardless of pass/fail.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { decideSaveAction } from "../scoring.js";
import { supabase } from "../storage.js";

const CLI_PATH = path.join(import.meta.dirname, "..", "..", "dist", "cli.js");
const CRUD_TEST_PROJECT = "crud-test-temp";

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [CLI_PATH, ...args], { encoding: "utf-8" });
}

// 1. decideSaveAction returns "duplicate" ("skip", in the task's wording)
// for near-identical content.
test('decideSaveAction returns "duplicate" for near-identical content', () => {
  const existing = [{ id: "mem-1", content: "add stripe webhook signature verification" }];
  const decision = decideSaveAction("add stripe webhook signature verification", existing);
  assert.equal(decision.action, "duplicate");
});

// 2. decideSaveAction returns "superseded" ("replace", in the task's
// wording) for contradicting content.
test('decideSaveAction returns "superseded" for contradicting content', () => {
  const existing = [{ id: "mem-1", content: "use redis for session storage" }];
  const decision = decideSaveAction("we switched from redis to postgres for session storage", existing);
  assert.equal(decision.action, "superseded");
});

// 3. decideSaveAction returns "created" ("create", in the task's wording)
// for genuinely new content.
test('decideSaveAction returns "created" for genuinely new content', () => {
  const existing = [{ id: "mem-1", content: "use redis for session storage" }];
  const decision = decideSaveAction("add rate limiting to the public api gateway", existing);
  assert.equal(decision.action, "created");
});

after(async () => {
  const { data: mem } = await supabase.from("memories").select("id").eq("project", CRUD_TEST_PROJECT);
  const ids = (mem ?? []).map((m: { id: string }) => m.id);
  if (ids.length > 0) {
    const idList = ids.join(",");
    await supabase.from("memory_links").delete().or(`source_id.in.(${idList}),target_id.in.(${idList})`);
  }
  await supabase.from("memories").delete().eq("project", CRUD_TEST_PROJECT);
});

// 4. A duplicate commit_sha is recognized by the check-commit guard
// (src/cli.ts cmdCheckCommit) rather than producing a second memory for
// the same commit — this is the actual mechanism behind "saving a memory
// with a duplicate commit_sha doesn't create a new one": the hook calls
// `cm check-commit` once per invocation and skips its entire capture
// pass if it reports the commit_sha already has a memory, rather than
// cmdSave de-duplicating per individual save. Exit code is inverted:
// 0 = not seen yet (proceed), 1 = already has a memory (duplicate, skip).
test("check-commit: fresh sha allowed, then blocked once a memory exists for it", () => {
  const sha = `test-sha-${Date.now()}-fresh`;

  // No memory for this sha yet — check-commit should exit 0 (allowed).
  runCli(["check-commit", CRUD_TEST_PROJECT, sha]);

  // Save a memory tagged with that sha.
  runCli(["save", CRUD_TEST_PROJECT, "decision", "duplicate commit_sha guard test", "--force", "--commit-sha", sha]);

  // Now the same sha must be blocked (non-zero exit = duplicate).
  assert.throws(() => runCli(["check-commit", CRUD_TEST_PROJECT, sha]));
});

// 5. cm pin sets pinned=true.
test("cm pin sets pinned=true on the target memory", async () => {
  runCli(["save", CRUD_TEST_PROJECT, "decision", "memory to be pinned in crud test", "--force"]);
  const { data } = await supabase
    .from("memories")
    .select("id")
    .eq("project", CRUD_TEST_PROJECT)
    .eq("content", "memory to be pinned in crud test")
    .single();
  assert.ok(data);

  runCli(["pin", CRUD_TEST_PROJECT, data.id]);

  const { data: after_ } = await supabase.from("memories").select("pinned").eq("id", data.id).single();
  assert.ok(after_);
  assert.equal(after_.pinned, true);
});

// 6. cm unpin sets pinned=false.
test("cm unpin sets pinned=false on the target memory", async () => {
  runCli(["save", CRUD_TEST_PROJECT, "decision", "memory to be unpinned in crud test", "--force"]);
  const { data } = await supabase
    .from("memories")
    .select("id")
    .eq("project", CRUD_TEST_PROJECT)
    .eq("content", "memory to be unpinned in crud test")
    .single();
  assert.ok(data);

  runCli(["pin", CRUD_TEST_PROJECT, data.id]);
  runCli(["unpin", CRUD_TEST_PROJECT, data.id]);

  const { data: after_ } = await supabase.from("memories").select("pinned").eq("id", data.id).single();
  assert.ok(after_);
  assert.equal(after_.pinned, false);
});
