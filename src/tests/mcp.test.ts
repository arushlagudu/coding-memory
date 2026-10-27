// Contract tests for the MCP server (src/index.ts), run against the real
// Supabase backend (matching the convention in crud.test.ts /
// regression.test.ts) via a dedicated throwaway project name, cleaned up
// in after() regardless of pass/fail. The server is exercised exactly as
// a real MCP client would: spawned as a child process over stdio, using
// the SDK's own Client + StdioClientTransport rather than hand-rolled
// JSON-RPC framing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { analyzeCodebase } from "../ast-index.js";
import { supabase } from "../storage.js";

const DIST_INDEX_PATH = path.join(import.meta.dirname, "..", "..", "dist", "index.js");
const TEST_PROJECT = `mcp-test-${Date.now()}`;
const UNKNOWN_PROJECT = `mcp-test-unknown-${Date.now()}`;

let client: Client;
let astProjectDir: string;
let unindexedProjectDir: string;

before(async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [DIST_INDEX_PATH] });
  client = new Client({ name: "mcp-contract-test-client", version: "0.0.0" });
  await client.connect(transport);

  // Seed a tiny real AST index directly via ast-index.ts (not through the
  // MCP "analyze_codebase" tool — that tool isn't one of the 6 under test
  // here) so get_file_summary / find_dependencies have something to find.
  astProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-ast-"));
  fs.writeFileSync(
    path.join(astProjectDir, "sample.ts"),
    [
      'import { readFileSync } from "node:fs";',
      "export function sampleFn() { return readFileSync; }",
      "export class SampleClass {}",
      "",
    ].join("\n")
  );
  analyzeCodebase(astProjectDir);

  // A second, never-indexed directory — the "unknown project" analog for
  // the two AST-index tools, which key off a filesystem path rather than
  // a project name.
  unindexedProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-unindexed-"));
});

after(async () => {
  await client.close();

  for (const project of [TEST_PROJECT, UNKNOWN_PROJECT]) {
    const { data: mem } = await supabase.from("memories").select("id").eq("project", project);
    const ids = (mem ?? []).map((m: { id: string }) => m.id);
    if (ids.length > 0) {
      const idList = ids.join(",");
      await supabase.from("memory_links").delete().or(`source_id.in.(${idList}),target_id.in.(${idList})`);
    }
    await supabase.from("memories").delete().eq("project", project);
    await supabase.from("execution_log").delete().eq("project", project);
  }

  fs.rmSync(astProjectDir, { recursive: true, force: true });
  fs.rmSync(unindexedProjectDir, { recursive: true, force: true });
});

// --- session_start -----------------------------------------------------

test("session_start: happy path returns memories/fixes/budget shape", async () => {
  const result: any = await client.callTool({ name: "session_start", arguments: { project: TEST_PROJECT } });
  assert.equal(result.isError, undefined);
  assert.ok(Array.isArray(result.structuredContent.memories));
  assert.ok(Array.isArray(result.structuredContent.fixes));
  assert.ok(result.structuredContent.context_budget);
});

test("session_start: missing required param errors instead of crashing", async () => {
  const result: any = await client.callTool({ name: "session_start", arguments: {} });
  assert.equal(result.isError, true);
});

test("session_start: unknown project returns empty, not an error", async () => {
  const result: any = await client.callTool({ name: "session_start", arguments: { project: UNKNOWN_PROJECT } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.memories, []);
  assert.deepEqual(result.structuredContent.fixes, []);
});

// --- save_memory ---------------------------------------------------------

test("save_memory: happy path saves and reports created", async () => {
  const result: any = await client.callTool({
    name: "save_memory",
    arguments: {
      project: TEST_PROJECT,
      type: "decision",
      content: "mcp contract test: decided to use connection pooling for the test db",
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.saved, true);
  assert.equal(result.structuredContent.action, "created");
});

test("save_memory: missing required param errors instead of crashing", async () => {
  const result: any = await client.callTool({
    name: "save_memory",
    arguments: { project: TEST_PROJECT },
  });
  assert.equal(result.isError, true);
});

test("save_memory: unknown project is accepted, not an error", async () => {
  const result: any = await client.callTool({
    name: "save_memory",
    arguments: {
      project: UNKNOWN_PROJECT,
      type: "discovery",
      content: "mcp contract test: a never-seen project name still saves cleanly",
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.saved, true);
});

// --- search_past_solutions ------------------------------------------------

test("search_past_solutions: happy path returns a results array", async () => {
  const result: any = await client.callTool({
    name: "search_past_solutions",
    arguments: { project: TEST_PROJECT, query: "pooling" },
  });
  assert.equal(result.isError, undefined);
  assert.ok(Array.isArray(result.structuredContent.results));
});

test("search_past_solutions: missing required param errors instead of crashing", async () => {
  const result: any = await client.callTool({
    name: "search_past_solutions",
    arguments: { project: TEST_PROJECT },
  });
  assert.equal(result.isError, true);
});

test("search_past_solutions: unknown project returns empty, not an error", async () => {
  const result: any = await client.callTool({
    name: "search_past_solutions",
    arguments: { project: UNKNOWN_PROJECT, query: "anything" },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.results, []);
});

// --- record_fix ------------------------------------------------------------

test("record_fix: happy path records and reports saved", async () => {
  const result: any = await client.callTool({
    name: "record_fix",
    arguments: {
      project: TEST_PROJECT,
      problem: "mcp contract test: problem X",
      solution: "mcp contract test: solution Y",
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.saved, true);
});

test("record_fix: missing required param errors instead of crashing", async () => {
  const result: any = await client.callTool({
    name: "record_fix",
    arguments: { project: TEST_PROJECT, problem: "missing solution" },
  });
  assert.equal(result.isError, true);
});

test("record_fix: unknown project is accepted, not an error", async () => {
  const result: any = await client.callTool({
    name: "record_fix",
    arguments: {
      project: UNKNOWN_PROJECT,
      problem: "mcp contract test: unknown-project problem",
      solution: "mcp contract test: unknown-project solution",
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.saved, true);
});

// --- get_file_summary --------------------------------------------------------

test("get_file_summary: happy path returns the indexed functions/classes", async () => {
  const result: any = await client.callTool({
    name: "get_file_summary",
    arguments: { project_path: astProjectDir, file_name: "sample.ts" },
  });
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent.functions.includes("sampleFn"));
  assert.ok(result.structuredContent.classes.includes("SampleClass"));
});

test("get_file_summary: missing required param errors instead of crashing", async () => {
  const result: any = await client.callTool({
    name: "get_file_summary",
    arguments: { project_path: astProjectDir },
  });
  assert.equal(result.isError, true);
});

// Unlike the project-keyed memory tools, there's no sensible "empty" shape
// for a file lookup with no index at all — getFileSummary/findDependencies
// (src/ast-index.ts) deliberately throw in that case, which the MCP SDK
// converts into a graceful isError:true tool result rather than crashing
// the server. That's the correct behavior here, not a bug.
test("get_file_summary: unindexed project path errors gracefully, not a crash", async () => {
  const result: any = await client.callTool({
    name: "get_file_summary",
    arguments: { project_path: unindexedProjectDir, file_name: "sample.ts" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /AST index|analyze_codebase/i);
});

// --- find_dependencies ----------------------------------------------------

test("find_dependencies: happy path returns the indexed imports", async () => {
  const result: any = await client.callTool({
    name: "find_dependencies",
    arguments: { project_path: astProjectDir, file_name: "sample.ts" },
  });
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent.imports.includes("node:fs"));
});

test("find_dependencies: missing required param errors instead of crashing", async () => {
  const result: any = await client.callTool({
    name: "find_dependencies",
    arguments: { file_name: "sample.ts" },
  });
  assert.equal(result.isError, true);
});

test("find_dependencies: unindexed project path errors gracefully, not a crash", async () => {
  const result: any = await client.callTool({
    name: "find_dependencies",
    arguments: { project_path: unindexedProjectDir, file_name: "sample.ts" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /AST index|analyze_codebase/i);
});
