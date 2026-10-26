// Hook integration tests against real temporary git repos. These hit the
// real Supabase backend (same convention as regression.test.ts) — each
// test uses its own throwaway project name, cleaned up in `after()`
// regardless of pass/fail. No MCP contract tests yet (Phase 2, per the
// user). Run with `npm test`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { supabase } from "../storage.js";

const CLI_PATH = path.join(import.meta.dirname, "..", "..", "dist", "cli.js");
const projectsToCleanUp: string[] = [];
let uniqueCounter = 0;

function uniqueProject(label: string): string {
  uniqueCounter++;
  const project = `hooktest-${label}-${Date.now()}-${uniqueCounter}`;
  projectsToCleanUp.push(project);
  return project;
}

function makeTempRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "stackmem-hooktest-repo-"));
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
}

// cm init also registers Claude Code hooks, the MCP server, and editor
// MCP configs into $HOME — scoped to a scratch HOME so none of that
// touches this machine's real config, same convention used throughout
// manual verification earlier in this phase.
function initStackmem(dir: string, project: string): void {
  const fakeHome = mkdtempSync(path.join(tmpdir(), "stackmem-hooktest-home-"));
  writeFileSync(path.join(fakeHome, ".claude.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
  execFileSync(process.execPath, [CLI_PATH, "init", project, "."], {
    cwd: dir,
    env: { ...process.env, HOME: fakeHome },
  });
}

function commit(dir: string, message: string, files: Record<string, string> = { "f.txt": "x" }): void {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content, "utf-8");
  }
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.email=a@b.com", "-c", "user.name=t", "commit", "-q", "-m", message],
    { cwd: dir }
  );
}

async function fetchMemories(project: string): Promise<Array<{ content: string; type: string }>> {
  const { data, error } = await supabase
    .from("memories")
    .select("content, type")
    .eq("project", project);
  if (error) throw new Error(error.message);
  return data ?? [];
}

after(async () => {
  for (const project of projectsToCleanUp) {
    const { data: mem } = await supabase.from("memories").select("id").eq("project", project);
    const ids = (mem ?? []).map((m: { id: string }) => m.id);
    if (ids.length > 0) {
      const idList = ids.join(",");
      await supabase.from("memory_links").delete().or(`source_id.in.(${idList}),target_id.in.(${idList})`);
    }
    await supabase.from("memories").delete().eq("project", project);
    await supabase.from("execution_log").delete().eq("project", project);
  }
});

// 1. Fresh repo: cm init writes all expected files.
test("fresh repo: cm init writes all expected files", () => {
  const dir = makeTempRepo();
  try {
    gitInit(dir);
    const project = uniqueProject("init");
    initStackmem(dir, project);

    for (const file of [
      ".stackmem",
      "CLAUDE.md",
      "AGENTS.md",
      "GEMINI.md",
      ".cursorrules",
      ".windsurfrules",
      ".gitignore",
      path.join(".cursor", "rules", "stackmem.md"),
      path.join(".coding-memory", "post-commit-hook.mjs"),
      path.join(".git", "hooks", "post-commit"),
      path.join(".git", "hooks", "post-rewrite"),
      path.join(".claude", "settings.json"),
    ]) {
      assert.ok(existsSync(path.join(dir, file)), `expected ${file} to exist`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2. Commit with a "feat:" message saves a decision.
test('commit with a "feat:" message saves a decision', async () => {
  const dir = makeTempRepo();
  try {
    gitInit(dir);
    const project = uniqueProject("feat");
    initStackmem(dir, project);
    commit(dir, "feat: add stripe webhook signature verification logic today");

    const memories = await fetchMemories(project);
    assert.ok(
      memories.some((m) => m.type === "decision" && m.content.includes("stripe webhook")),
      `expected a decision memory, got: ${JSON.stringify(memories)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 3. Commit with a "chore:" message saves nothing.
test('commit with a "chore:" message saves nothing', async () => {
  const dir = makeTempRepo();
  try {
    gitInit(dir);
    const project = uniqueProject("chore");
    initStackmem(dir, project);
    commit(dir, "chore: bump dependency versions across the board today");

    const memories = await fetchMemories(project);
    assert.equal(memories.length, 0, `expected no memories, got: ${JSON.stringify(memories)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 4. Commit message with an AWS key saves [REDACTED], not the raw key.
test("commit message with an AWS key saves [REDACTED], not the raw key", async () => {
  const dir = makeTempRepo();
  try {
    gitInit(dir);
    const project = uniqueProject("redact");
    initStackmem(dir, project);
    commit(dir, "feat: rotate credentials AKIAABCDEFGHIJ123456 for the deploy pipeline");

    const memories = await fetchMemories(project);
    const decision = memories.find((m) => m.type === "decision");
    assert.ok(decision, `expected a decision memory, got: ${JSON.stringify(memories)}`);
    assert.doesNotMatch(decision!.content, /AKIA[0-9A-Z]{16}/);
    assert.match(decision!.content, /\[REDACTED\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 5. Amend doesn't create a duplicate memory for the same final commit
// sha (SHA idempotency via check-commit — see src/cli.ts cmdCheckCommit).
// Amending legitimately produces a NEW commit_sha, which legitimately
// gets its own new capture — that's 2 decisions total, correctly. What
// the idempotency guard actually prevents is post-commit AND
// post-rewrite both capturing that same amended sha a second time.
test("amend doesn't create a duplicate memory for the same commit_sha (SHA idempotency)", async () => {
  const dir = makeTempRepo();
  try {
    gitInit(dir);
    const project = uniqueProject("amend");
    initStackmem(dir, project);
    commit(dir, "feat: initial commit for amend idempotency test today");

    execFileSync(
      "git",
      ["-c", "user.email=a@b.com", "-c", "user.name=t", "commit", "--amend", "-q", "-m", "feat: amended commit for amend idempotency test today"],
      { cwd: dir }
    );

    const { data, error } = await supabase
      .from("memories")
      .select("content, commit_sha")
      .eq("project", project)
      .eq("type", "decision");
    if (error) throw new Error(error.message);

    const shas = (data ?? []).map((m) => m.commit_sha);
    assert.equal(
      shas.length,
      new Set(shas).size,
      `expected no two decisions sharing a commit_sha, got: ${JSON.stringify(data)}`
    );
    assert.ok((data ?? []).some((m) => m.content.includes("amended commit")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 6. Hook times out after 2s and exits 0 (never blocks the commit).
test("hook times out after 2s and exits 0", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stackmem-hooktest-timeout-"));
  const scriptPath = path.join(dir, "slow-hook.mjs");
  // Mirrors buildHookLogicScript's main()/runHook() timeout wrapper
  // (src/cli.ts) exactly, with runHook() replaced by an artificial 5s
  // hang to deterministically force the timeout path — forcing the real
  // hook's own body (git/network calls) to take >2s isn't something a
  // test can reliably control.
  writeFileSync(
    scriptPath,
    `
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const HOOK_TIMEOUT_MS = 2000;

function logHookError(error) {
  try {
    const logPath = join(process.cwd(), ".coding-memory", "hook.log");
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, \`[\${new Date().toISOString()}] \${error instanceof Error ? error.message : String(error)}\\n\`);
  } catch {}
}

async function runHook() {
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

async function main() {
  let timeoutHandle;
  try {
    await Promise.race([
      runHook(),
      new Promise((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error("stackmem post-commit hook exceeded " + HOOK_TIMEOUT_MS + "ms timeout")),
          HOOK_TIMEOUT_MS
        );
      }),
    ]);
  } catch (error) {
    logHookError(error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

main().finally(() => process.exit(0));
`,
    "utf-8"
  );

  try {
    const start = Date.now();
    execFileSync(process.execPath, [scriptPath], { cwd: dir, encoding: "utf-8" });
    const elapsedMs = Date.now() - start;

    assert.ok(elapsedMs < 4000, `expected timeout around 2s, took ${elapsedMs}ms`);
    const log = readFileSync(path.join(dir, ".coding-memory", "hook.log"), "utf-8");
    assert.match(log, /exceeded 2000ms timeout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 7. An existing (foreign) post-commit hook is chained, not overwritten.
test("existing post-commit hook is chained, not overwritten", () => {
  const dir = makeTempRepo();
  try {
    gitInit(dir);
    const hooksDir = path.join(dir, ".git", "hooks");
    const foreignHookPath = path.join(hooksDir, "post-commit");
    const markerFile = path.join(dir, "foreign-hook-ran.log");
    writeFileSync(foreignHookPath, `#!/bin/sh\necho ran >> "${markerFile}"\n`, "utf-8");
    execFileSync("chmod", ["+x", foreignHookPath]);

    const project = uniqueProject("chain");
    initStackmem(dir, project);

    const hookContent = readFileSync(foreignHookPath, "utf-8");
    assert.match(hookContent, /stackmem-managed/);
    assert.ok(
      existsSync(path.join(hooksDir, "post-commit.pre-stackmem")),
      "expected the foreign hook to be preserved as a backup"
    );

    commit(dir, "feat: verify the foreign hook actually still runs today");
    assert.ok(existsSync(markerFile), "expected the chained foreign hook to have run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 8. Lockfile changes don't create memories (Item 3's diff filtering).
test("lockfile changes don't create memories", async () => {
  const dir = makeTempRepo();
  try {
    gitInit(dir);
    const project = uniqueProject("lockfile");
    initStackmem(dir, project);
    commit(dir, "feat: baseline commit before lockfile-only change today");

    commit(
      dir,
      "chore: update lockfile with an embedded todo marker test",
      { "package-lock.json": '{"name":"x"}\n// TODO: this should be ignored since it is a lockfile\n' }
    );

    const memories = await fetchMemories(project);
    assert.ok(
      !memories.some((m) => m.content.includes("TODO")),
      `expected no TODO memory from the lockfile diff, got: ${JSON.stringify(memories)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 9. cm uninstall restores the chained (foreign) hook, not just deletes it.
test("cm uninstall restores a chained foreign hook", () => {
  const dir = makeTempRepo();
  try {
    gitInit(dir);
    const hooksDir = path.join(dir, ".git", "hooks");
    const foreignHookPath = path.join(hooksDir, "post-commit");
    const originalContent = "#!/bin/sh\necho original-foreign-hook\n";
    writeFileSync(foreignHookPath, originalContent, "utf-8");
    execFileSync("chmod", ["+x", foreignHookPath]);

    const project = uniqueProject("uninstall-chain");
    initStackmem(dir, project);
    assert.match(readFileSync(foreignHookPath, "utf-8"), /stackmem-managed/);

    const fakeHome = mkdtempSync(path.join(tmpdir(), "stackmem-hooktest-home-"));
    writeFileSync(path.join(fakeHome, ".claude.json"), JSON.stringify({ mcpServers: { stackmem: {} } }), "utf-8");
    execFileSync(process.execPath, [CLI_PATH, "uninstall", project, "."], {
      cwd: dir,
      env: { ...process.env, HOME: fakeHome },
    });

    assert.equal(readFileSync(foreignHookPath, "utf-8"), originalContent);
    assert.ok(
      !existsSync(path.join(hooksDir, "post-commit.pre-stackmem")),
      "expected the backup file to be cleaned up after restoring"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
