// Regression tests for bugs fixed during Phase 0 hardening. Uses Node's
// built-in test runner (no Jest) — run with `npm test`.
//
// Tests that exercise the CLI's observable contract (printed output, exit
// codes) spawn the compiled dist/cli.js as a subprocess rather than
// importing src/cli.ts directly — that's a closer match to how a real user
// (or the git hook) invokes it, and avoids coupling the test to internal
// function names. Tests of internal mechanisms (seeding dedup, redaction,
// commit routing, the hook timeout contract) import directly instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { trySeedMemory } from "../cli.js";
import {
  redactSecrets,
  classifyConventionalCommit,
  isQualityMessage,
} from "../scoring.js";

const CLI_PATH = path.join(import.meta.dirname, "..", "..", "dist", "cli.js");

// Isolates a CLI subprocess from the real ~/.claude.json and any real
// .stackmem in the caller's cwd.
function runCli(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const fakeHome = mkdtempSync(path.join(tmpdir(), "stackmem-fakehome-"));
  try {
    execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, HOME: fakeHome },
      encoding: "utf-8",
    });
    return { stdout: "", stderr: "", status: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      status: error.status ?? 1,
    };
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

// Re-run successfully (for assertions that need stdout on the happy path,
// where execFileSync wouldn't throw and the catch branch above never fires).
function runCliOk(args: string[], cwd: string): string {
  const fakeHome = mkdtempSync(path.join(tmpdir(), "stackmem-fakehome-"));
  try {
    return execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, HOME: fakeHome },
      encoding: "utf-8",
    });
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

function makeTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "stackmem-regression-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

// 1. cm init on a project without .gitignore creates one with node_modules/.
test("cm init creates .gitignore with node_modules/ when none exists", () => {
  const dir = makeTempRepo();
  try {
    runCliOk(["init", "regression-test-init-gitignore", "."], dir);
    const gitignore = readFileSync(path.join(dir, ".gitignore"), "utf-8");
    assert.match(gitignore, /node_modules\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2. cm save with an invalid type prints a targeted error, not full usage.
test("cm save with invalid type prints a targeted error, not the usage dump", () => {
  const dir = makeTempRepo();
  try {
    const result = runCli(
      ["save", "regression-test-invalid-type", "bogus-type", "some memory content here"],
      dir
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid memory type 'bogus-type'/);
    assert.doesNotMatch(result.stderr, /Usage:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 3. cm delete with a fake UUID prints "No memory found".
test('cm delete with a nonexistent UUID prints "No memory found"', () => {
  const dir = makeTempRepo();
  try {
    const stdout = runCliOk(
      ["delete", "regression-test-fake-uuid", "00000000-0000-0000-0000-000000000000"],
      dir
    );
    assert.match(stdout, /No memory found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 4. cm resolve with a fake UUID prints "No memory found".
test('cm resolve with a nonexistent UUID prints "No memory found"', () => {
  const dir = makeTempRepo();
  try {
    const stdout = runCliOk(
      ["resolve", "regression-test-fake-uuid", "00000000-0000-0000-0000-000000000000"],
      dir
    );
    assert.match(stdout, /No memory found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 5. cm fix with empty strings prints a validation error.
test("cm fix with empty problem/solution prints a validation error", () => {
  const dir = makeTempRepo();
  try {
    const result = runCli(["fix", "regression-test-empty-fix", "", ""], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot be empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 6. cm save with content over 500 chars prints a length error.
test("cm save with content over 500 chars prints a length error", () => {
  const dir = makeTempRepo();
  try {
    const longContent = "x".repeat(501);
    const result = runCli(["save", "regression-test-too-long", "decision", longContent], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /too long/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 7. cm init run twice does not duplicate seed memories (mocked Supabase
// client — verify insert called exactly once per type across both runs).
test("trySeedMemory does not insert the same seed twice across two init runs", async () => {
  const insertCalls: Array<{ table: string; row: unknown }> = [];
  const mockClient = {
    from(table: string) {
      return {
        insert: async (row: unknown) => {
          insertCalls.push({ table, row });
          return { error: null };
        },
      };
    },
  };

  const project = "regression-test-seed-dedup";
  const techStackContent = "tech stack: zod, tree-sitter";
  const envVarsContent = "required env vars: DATABASE_URL, API_PORT";

  // First `cm init`: nothing seeded yet.
  let existingMemories: { id: string; content: string }[] = [];
  const firstDiscoveryInserted = await trySeedMemory(
    project,
    existingMemories,
    "discovery",
    techStackContent,
    mockClient
  );
  const firstConstraintInserted = await trySeedMemory(
    project,
    existingMemories,
    "constraint",
    envVarsContent,
    mockClient
  );
  assert.equal(firstDiscoveryInserted, true);
  assert.equal(firstConstraintInserted, true);

  // Second `cm init`: existingMemories now reflects what the first run
  // inserted — this is what actually happens between two real runs, since
  // seedMemories re-fetches existing memories from Supabase each time.
  existingMemories = [
    { id: "seed-1", content: techStackContent },
    { id: "seed-2", content: envVarsContent },
  ];
  const secondDiscoveryInserted = await trySeedMemory(
    project,
    existingMemories,
    "discovery",
    techStackContent,
    mockClient
  );
  const secondConstraintInserted = await trySeedMemory(
    project,
    existingMemories,
    "constraint",
    envVarsContent,
    mockClient
  );
  assert.equal(secondDiscoveryInserted, false);
  assert.equal(secondConstraintInserted, false);

  const discoveryInsertCount = insertCalls.filter(
    (call) => (call.row as any).type === "discovery"
  ).length;
  const constraintInsertCount = insertCalls.filter(
    (call) => (call.row as any).type === "constraint"
  ).length;
  assert.equal(discoveryInsertCount, 1);
  assert.equal(constraintInsertCount, 1);
});

// 8. Secret redaction: content with an AWS key gets [REDACTED].
test("redactSecrets replaces an AWS access key with [REDACTED]", () => {
  const redacted = redactSecrets("deployed with AKIAABCDEFGHIJ123456 in the env");
  assert.doesNotMatch(redacted, /AKIA[0-9A-Z]{16}/);
  assert.match(redacted, /\[REDACTED\]/);
});

// 9. Conventional commit: "chore: update deps" routes to skip, not decision
// (the conventional-routing equivalent of the old isQualityMessage filter).
test('conventional commit "chore: update deps" is routed to skip, not decision', () => {
  assert.equal(classifyConventionalCommit("chore: update deps"), "skip");
  // Sanity check against the pre-conventional-routing filter it replaces
  // for this case: a bare quality-filter reading would have let this
  // through (it's a well-formed, >15-char message), which is exactly why
  // conventional-commit routing has to run first and skip it outright.
  assert.equal(isQualityMessage("chore: update deps"), true);
});

// 10. Hook timeout: if hook logic exceeds 2s, the process still exits 0
// (and logs the timeout) instead of hanging or failing the commit.
test("hook timeout wrapper exits 0 within ~2s when the hook body hangs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stackmem-hook-timeout-"));
  const scriptPath = path.join(dir, "slow-hook.mjs");
  // Mirrors buildHookLogicScript's main()/runHook() timeout wrapper
  // (src/cli.ts) exactly, with runHook() replaced by an artificial 5s hang
  // to deterministically force the timeout path.
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
    const message = error instanceof Error ? (error.stack || error.message) : String(error);
    appendFileSync(logPath, \`[\${new Date().toISOString()}] \${message}\\n\`);
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
