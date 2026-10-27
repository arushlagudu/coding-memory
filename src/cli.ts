#!/usr/bin/env tsx
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { analyzeCodebase } from "./ast-index.js";
import { GITHUB_CLIENT_ID, VAULT_URL } from "./config.js";
import { defaultConfigFileContents, readStackmemConfig, STACKMEM_CONFIG_FILENAME } from "./config-file.js";
import {
  localIncrementAccessCounts,
  localListFixes,
  localListMemories,
  localResolveMemory,
  localSaveFix,
  localSaveMemory,
} from "./local-store.js";
import { getDeviceId } from "./device.js";
import {
  applyContextBudget,
  buildSummaryContent,
  clusterMemories,
  computeDecayScore,
  computeMemoryLinks,
  decideSaveAction,
  estimateTokens,
  extractEntities,
  indicatesFailedApproach,
  isAuthRelatedFile,
  isCodeFile,
  hasTokenOverlap,
  isQualityMessage,
  parseUtcDate,
  redactSecrets,
  scoreMemoryRelevance,
  tokenize,
} from "./scoring.js";
import { reportError } from "./error-reporting.js";
import { supabase } from "./storage.js";
import {
  disableTelemetry,
  enableTelemetry,
  isTelemetryEnabled,
  maybeTrackDailyActive,
  trackEvent,
} from "./telemetry.js";

// Checked as early as ESM import hoisting allows — before any command
// dispatch, config loading, or network call — so an unsupported Node
// version fails with a clear message instead of an obscure syntax or
// API error from deeper in the dependency chain.
const NODE_MAJOR_VERSION = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR_VERSION < 18) {
  console.error(
    `Error: stackmem requires Node 18 or higher.\nYou are running Node ${process.versions.node}.\nPlease upgrade: https://nodejs.org`
  );
  process.exit(1);
}

const CONTEXT_BUDGET_TOKENS = 2000;
const COMPRESSION_THRESHOLD = 20;
const CLI_PATH = fileURLToPath(import.meta.url);
// The hook must always shell out to the compiled CLI, never `tsx src/cli.ts`
// directly — tsx's esbuild transform fails when invoked from inside a git
// hook's stripped-down shell environment.
const DIST_CLI_PATH = nodePath.join(nodePath.dirname(CLI_PATH), "..", "dist", "cli.js");
const DIST_INDEX_PATH = nodePath.join(nodePath.dirname(CLI_PATH), "..", "dist", "index.js");

// Written into every file/hook stackmem manages, so `cm uninstall` (and the
// hook installer's chaining check) can tell "ours, safe to remove/replace"
// apart from a user's own pre-existing file/hook with the same name.
const STACKMEM_HOOK_MARKER = "# stackmem-managed";
const CLAUDE_MD_MARKER = "the stackmem MCP server will automatically load memories for this project";
const RULES_FILE_MARKER = "# stackmem — project memory (auto-updated)";
const HOOK_BACKUP_SUFFIX = ".pre-stackmem";

const MEMORY_TYPES = ["decision", "rejection", "constraint", "discovery"] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

const TYPE_LABELS: Record<MemoryType, string> = {
  decision: "Decisions",
  constraint: "Constraints",
  discovery: "Discoveries",
  rejection: "Rejections",
};

function usage(): never {
  console.error(`Usage:
  cm start [project] [--hook] [--local]
  cm save [project] <type> <content> [--force] [--local]  (type: decision|rejection|constraint|discovery)
  cm fix [project] <problem> <solution> [--local]
  cm analyze [project] <path>
  cm search [--project <name>] <query> [--local]
  cm resolve [project] <memory-id>
  cm pin [project] <memory-id>
  cm unpin [project] <memory-id>
  cm review [--project <name>]
  cm edit [project] <memory-id>
  cm delete [project] <memory-id>
  cm inspect [project] <memory-id>
  cm compress [project]
  cm init <project> <path> [--config]
  cm init --wizard [path]
  cm uninstall [project] [path]
  cm link
  cm login
  cm open [--project <name>]
  cm purge [--project <name>] [--all]
  cm sync
  cm context [--project <name>] <task> [--hook] [--local]
  cm why [--project <name>] <file>
  cm session-end [project] [--summary <text>] [--errors <a,b>] [--files <a,b>] [--approaches <a,b>] [--hook]
  cm doctor [--fix]
  cm status [--project <name>]
  cm undo [project]
  cm export [filename]
  cm import [project] <filename>
  cm telemetry [--enable] [--disable]
  cm help

  [project] is optional if a .stackmem file exists in the current
  directory (written by 'cm init'). Otherwise it must be given explicitly.
  search/context take --project instead of a positional project, since a
  bare query/task can't otherwise be told apart from a project name.`);
  process.exit(1);
}

function cmdHelp() {
  console.log(`cm — coding memory CLI

  Works with Claude Code, Cursor, and Windsurf — 'cm init' writes the
  CLAUDE.md, .cursorrules, and .windsurfrules files each tool reads.

  [project] is optional everywhere below if a .stackmem file exists in
  the current directory (written by 'cm init'). Otherwise pass it explicitly.

  --local (on save/fix/start/search/context) reads and writes
  .coding-memory/local-store.json instead of Supabase — no network
  calls at all. Prints "(local)" on output so it's never ambiguous
  which store a result came from. Set "localOnly": true in
  .stackmem.json to use the local store automatically, with no flag,
  on every one of these commands.

  cm start [project] [--hook] [--local]
      Load all unresolved memories for a project, sorted by decay
      score and capped at a 2000 token context budget, grouped by
      type (decisions, constraints, discoveries, rejections), with
      linked memory ids shown under each entry. --hook switches to
      plain-text output (no ids, scores, or separator lines) for use
      as a Claude Code SessionStart hook command — see cm init.

  cm save [project] <type> <content> [--force] [--local]
      Save a new memory. <type> is one of: decision, rejection,
      constraint, discovery. Automatically links to related existing
      memories. If the new memory contradicts an existing one, prompts
      to keep the old memory or replace it — pass --force to skip the
      prompt and always replace.

  cm fix [project] <problem> <solution> [--local]
      Record a problem and its solution for future reference.

  cm analyze [project] <path>
      Build an AST index (files, functions, classes) for the codebase
      at <path>.

  cm search [--project <name>] <query> [--local]
      Search saved memories and past fixes for a project matching
      <query>. The whole query is always the full remaining text — use
      --project to search a project other than the one in .stackmem.

  cm resolve [project] <memory-id>
      Mark a memory as resolved.

  cm pin [project] <memory-id>
      Pin a memory: it scores 999 in decay ranking (always sorts
      first, never decays) and shows in its own "Pinned" section at
      the top of 'cm start', ahead of its normal type group.

  cm unpin [project] <memory-id>
      Un-pin a memory, returning it to normal decay-based ranking.

  cm review [--project <name>]
      Walk through suggested memories one at a time (hook-captured
      memories start as suggested — see cm save/cm init). For each:
      (k)eep promotes it to permanent, (e)dit opens $EDITOR (or an
      inline prompt) for new content then keeps it, (d)rop deletes
      it, (s)kip leaves it suggested for next time, (q)uit stops and
      reports progress so far. Prints a kept/dropped/skipped summary.

  cm edit [project] <memory-id>
      Open a memory's content in $EDITOR (or an inline prompt if
      $EDITOR isn't set), save the result.

  cm delete [project] <memory-id>
      Delete a memory and any memory_links referencing it.

  cm inspect [project] <memory-id>
      Show a rich view of a single memory: type, content, created
      date, access count, decay score, and resolved status, plus
      every linked memory (in either link direction) with its link
      score, and any execution_log fixes whose problem or solution
      shares a key entity with the memory's content.

  cm compress [project]
      Cluster related unresolved memories (needs 20+) and collapse
      clusters of 3 or more into a single summary memory.

  cm init <project> <path> [--config]
      Install a git post-commit hook in the repo at <path>, register
      the stackmem MCP server with Claude Code, write a CLAUDE.md,
      .cursorrules, .windsurfrules, and .stackmem file, and seed
      initial memories from the project scan. .cursorrules and
      .windsurfrules are pre-filled with the project's current
      memories (for Cursor and Windsurf) and skipped if they already
      exist. The post-commit hook keeps them fresh afterward by
      running 'cm sync' on every commit — on disk only, never
      committed, so they don't double your commit count or conflict
      across branches. Both files are added to .gitignore. With
      --config, also writes a default .stackmem.json (ignore patterns,
      tokenBudget, decayLambda, captureTypes, minQualityScore — see
      src/config-file.ts) if one doesn't already exist.

  cm init --wizard [path]
      Interactive setup: prompts for the project name (detected from
      package.json or the directory name), which editors you use,
      whether hook-captured memories should start as suggested
      (pending 'cm review') or permanent immediately, and whether to
      create .stackmem.json — then runs the same 'cm init' above with
      those choices. [path] defaults to the current directory.

  cm uninstall [project] [path]
      Remove everything 'cm init' set up at <path> (defaults to the
      current directory): the git post-commit hook (restoring whatever
      hook it chained after, if any), .coding-memory/post-commit-hook.mjs,
      .coding-memory/ast-index.db and the .coding-memory/ directory
      itself if left empty, the .stackmem file, and CLAUDE.md /
      .cursorrules / .windsurfrules — the last three only if they still
      carry the stackmem marker, so hand-edited files are left alone.
      Also removes the stackmem entry from ~/.claude.json's mcpServers.
      [project] defaults to the .stackmem file at <path> if omitted.

  cm link
      Connect this device to your GitHub account in the hosted vault.
      Prints a 6-digit code, then waits for you to enter it at
      stackmem-vault.vercel.app/link while signed in. The code is
      single-use and expires after 10 minutes; polling stops when it
      does. Links are per-device, so run this once on each machine.

  cm login
      Sign in with GitHub via the device flow: prints a one-time code
      and https://github.com/login/device to open in a browser, then
      polls until you finish authorizing (or it times out after 10
      minutes). On success, stores the token and your GitHub username
      at ~/.stackmem-auth. Separate from 'cm link', which pairs this
      device with an account in the hosted vault — this is a plain
      GitHub sign-in with no vault involved.

  cm open [--project <name>]
      Open the hosted vault's page for this project in the default
      browser (open on Mac, xdg-open on Linux, start on Windows).

  cm purge [--project <name>] [--all]
      Permanently delete memories, fixes, and memory_links — with a
      typed confirmation first, never deletes on a flag alone.
      --project (or the one in .stackmem): deletes that project's
      data only, after you type the exact project name to confirm.
      --all: deletes everything for this device's device_id across
      every project, after you type DELETE to confirm. Prints the
      count of deleted records, or "Confirmation did not match" if
      you abort.

  cm sync
      Regenerate .cursorrules and .windsurfrules from the project's
      current unresolved memories (decay-ranked, capped at a 2000
      token budget) and its 5 most recent open execution_log fixes,
      overwriting both files on disk only (never git add/commit).
      Project is read from .stackmem.

  cm context [--project <name>] <task> [--hook] [--local]
      Return only the top 5 memories most relevant to a specific
      task, ranked by a blend of task relevance and decay score,
      as a markdown block capped at a 2000 token budget. Use
      --project to target a project other than the one in .stackmem.
      <task> is optional with --hook (ranks by decay alone) — used
      as a Claude Code PreCompact hook command; see cm init.

  cm why [--project <name>] <file>
      Show memories tied to a file: matched by Item 6's file_paths
      column (hook-captured commits that touched it) plus a plain
      content search for the file's path or basename, ranked by decay
      score and grouped by type. Prints a guidance message instead if
      nothing matches. Use --project to target a project other than
      the one in .stackmem.

  cm session-end [project] [--summary <text>] [--errors <a,b>] [--files <a,b>] [--approaches <a,b>] [--hook]
      Capture what happened in a session and extract memories: each
      error becomes an unsolved execution_log entry, each approach
      containing "failed", "didn't work", "reverted", or "switched
      away" becomes a rejection, a summary that passes the quality
      filter becomes a decision, auth-related files become a
      discovery, and any .ts/.js file triggers an AST re-index.
      Accepts the same fields as JSON on stdin instead of flags
      (project, summary, errors_encountered, files_touched,
      approaches_tried) when stdin is piped rather than a terminal.
      --hook is accepted for use as a Claude Code Stop hook command
      (see cm init) but is currently a no-op: Claude Code pipes its
      own hook payload on stdin, not this command's expected shape,
      so a Stop-triggered run captures 0 memories until a future
      phase parses the session transcript directly.

  cm doctor [--fix]
      Check every integration point in the current directory — backend
      connection, MCP registration, .stackmem, git hook, and memory
      count — and report what's working and what's broken. With --fix,
      attempt a repair after each failing check: re-register the MCP
      server, or re-install the git hook. A failed backend connection,
      a missing .stackmem file, or no memories yet can't be auto-fixed
      (they need a working network, 'cm init', or a commit respectively)
      — those print guidance instead. Reports "Fixed: <item>" or
      "Could not auto-fix: <item>" for each failing check.

  cm status [--project <name>]
      One-screen project summary: memory/pinned/suggested counts,
      recorded fixes, the active token budget (and whether it's the
      default or from .stackmem.json), time since the last capture,
      and hook/MCP/backend/editor registration status.

  cm undo [project]
      Delete the most recently saved unresolved memory (and any
      memory_links referencing it) for a project.

  cm export [filename]
      Export all unresolved memories, execution_log entries, and
      memory_links for a project to a JSON file. Defaults to
      <project>-memories.json.

  cm import [project] <filename>
      Import memories and execution_log entries from a JSON file
      produced by 'cm export'. Inserted under the current device_id
      and project; memory_links are skipped and get rebuilt by
      semantic linking the next time cm save runs.

  cm telemetry [--enable] [--disable]
      Opted out by default — no flag prints whether it's currently
      enabled or disabled. --enable/--disable turn anonymous usage
      stats (install, init, session_start, daily_active events —
      version, OS, Node version; never code, file paths, or memory
      content) on or off. 'cm init --wizard' asks once during setup;
      this is how to change your answer later.

  cm help
      Show this help message.`);
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

// --- optional project resolution ------------------------------------------

const STACKMEM_FILE = ".stackmem";

const MONOREPO_PARENT_LOOKUP_DEPTH = 3;

// Checks cwd, then up to 3 parent directories, for a .stackmem file — a
// monorepo subpackage (e.g. packages/api) won't have its own .stackmem,
// but the repo root will. When found in an ancestor, the project name
// gets the intervening path segments appended, e.g. "myapp/packages/api"
// — so a subpackage still reads/writes under its own namespace within
// the shared project, rather than silently resolving to just "myapp".
function readProjectFromFile(): string | null {
  let dir = process.cwd();
  const subdirSegments: string[] = [];

  for (let depth = 0; depth <= MONOREPO_PARENT_LOOKUP_DEPTH; depth++) {
    const stackmemPath = nodePath.join(dir, STACKMEM_FILE);
    if (nodeFs.existsSync(stackmemPath)) {
      const content = nodeFs.readFileSync(stackmemPath, "utf-8").trim();
      if (content.length === 0) return null;
      return subdirSegments.length > 0
        ? `${content}/${subdirSegments.reverse().join("/")}`
        : content;
    }

    const parent = nodePath.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    subdirSegments.push(nodePath.basename(dir));
    dir = parent;
  }

  return null;
}

// Catches the common habit-slip of typing `cm fix . "problem" "solution"` by
// muscle memory from `cm init <project> .` — "." (or "..", or anything
// path-shaped) is never a real project name, so an explicit arg this shape
// almost certainly means the caller meant to omit the project entirely.
function looksLikeAPath(value: string): boolean {
  return value === "." || value === ".." || value.includes("/") || value.includes("\\");
}

function requireProject(explicit: string | null): string {
  if (explicit && looksLikeAPath(explicit)) {
    console.error(
      `Warning: '${explicit}' is not a valid project name — reading from .stackmem instead.`
    );
    explicit = null;
  }

  if (explicit) return explicit;

  const fromFile = readProjectFromFile();
  if (fromFile) return fromFile;

  console.error(
    "No project specified and no .stackmem file found. Run 'cm init <project> .' first or pass a project name."
  );
  process.exit(1);
}

// For commands whose non-project args have a fixed count: if exactly that
// many args are given, project was omitted; if one more, the first is the
// project. Anything else is a usage error.
function splitOptionalProject(
  args: string[],
  fixedArgCount: number
): { project: string | null; rest: string[] } | null {
  if (args.length === fixedArgCount) return { project: null, rest: args };
  if (args.length === fixedArgCount + 1) return { project: args[0], rest: args.slice(1) };
  return null;
}

// For commands whose remaining arg is free-form text (a query or task),
// arg count can't disambiguate an omitted project from a multi-word query —
// "cm search bug fix" is ambiguous by count alone. Use .stackmem's presence
// instead: if it exists, nothing is positionally a project.
// Arg count can't disambiguate an omitted project from a multi-word query —
// "cm search bug fix" is ambiguous by count alone. Treating .stackmem's mere
// presence as "project omitted" (the previous approach) was worse: it
// silently swallowed an explicit project into the query text whenever a
// .stackmem file happened to exist in cwd, so "cm search otherproj auth bug"
// would search project X (from .stackmem) for the literal text "otherproj
// auth bug" with no error. Positional args are now always the full
// query/task; an explicit override uses --project <name> instead, which is
// never ambiguous and is never silently absorbed.
function splitProjectFromVariadic(args: string[]): { project: string | null; rest: string[] } {
  const flagIndex = args.indexOf("--project");
  if (flagIndex !== -1 && args[flagIndex + 1] !== undefined) {
    const project = args[flagIndex + 1];
    const rest = [...args.slice(0, flagIndex), ...args.slice(flagIndex + 2)];
    return { project, rest };
  }
  return { project: null, rest: args };
}

// Generic "--flag value" extractor for internal/provenance flags (not
// meant to be remembered by end users — only the hook and MCP server pass
// these). Unlike splitProjectFromVariadic's --project, these don't need
// special positional disambiguation, so one generic helper covers all of
// them: --commit-sha, --author, --source, --confidence, --files.
function extractValueFlag(args: string[], flag: string): { value: string | null; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1 || args[idx + 1] === undefined) return { value: null, rest: args };
  return { value: args[idx + 1], rest: [...args.slice(0, idx), ...args.slice(idx + 2)] };
}

// --local on cm save/fix/start/search/context, OR .stackmem.json's
// localOnly: true applying automatically with no flag needed.
function extractLocalFlag(args: string[]): { localMode: boolean; rest: string[] } {
  const idx = args.indexOf("--local");
  const explicitLocal = idx !== -1;
  const rest = explicitLocal ? [...args.slice(0, idx), ...args.slice(idx + 1)] : args;
  return { localMode: explicitLocal || readStackmemConfig().localOnly, rest };
}

// --- cm start ----------------------------------------------------------

const RECENT_COMMITS_FOR_FILE_SIGNAL = 5;
const BRANCH_NAME_BOOST = 1.2;
const RECENT_FILES_BOOST = 1.3;
const PR_TITLE_BOOST = 1.2;

// null means "signal unavailable" (git/gh failed, not enough history, gh
// not installed, no open PR, etc.) — every one of these is a soft skip,
// never an error, per the task spec.
function getBranchNameTokens(): Set<string> | null {
  let branch: string;
  try {
    // symbolic-ref (not rev-parse --abbrev-ref) specifically because it
    // fails on a detached HEAD rather than returning the literal string
    // "HEAD" — that failure is the signal this needs to distinguish a
    // real detached-HEAD state from "not a git repo at all" below.
    branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    try {
      execFileSync("git", ["rev-parse", "HEAD"], { stdio: "pipe" });
      // HEAD resolves to a real commit but symbolic-ref failed — genuinely
      // detached, not a missing repo. Still a valid state to rank in, not
      // a reason to skip the signal entirely.
      branch = "detached";
    } catch {
      return null;
    }
  }

  const tokens = tokenize(branch);
  return tokens.size > 0 ? tokens : null;
}

function getRecentlyTouchedFiles(): Set<string> | null {
  try {
    const isShallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // A shallow clone can't look back RECENT_COMMITS_FOR_FILE_SIGNAL
    // commits — degrade gracefully rather than attempting (and either
    // failing, or silently returning an incomplete picture of "recent").
    if (isShallow === "true") return null;
  } catch {
    // --is-shallow-repository itself failing (very old git, or no repo at
    // all) isn't a reason to skip on its own — the lookback below will
    // fail (and get caught) or succeed on its own merits either way.
  }

  try {
    const output = execFileSync(
      "git",
      ["diff", "--name-only", `HEAD~${RECENT_COMMITS_FOR_FILE_SIGNAL}`, "HEAD"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const files = output.split("\n").map((f) => f.trim()).filter(Boolean);
    return files.length > 0 ? new Set(files) : null;
  } catch {
    // Fewer than RECENT_COMMITS_FOR_FILE_SIGNAL commits in history, or
    // not a git repo at all — skip gracefully.
    return null;
  }
}

function getOpenPrTitleTokens(): Set<string> | null {
  try {
    const title = execFileSync("gh", ["pr", "view", "--json", "title", "-q", ".title"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!title) return null;
    const tokens = tokenize(title);
    return tokens.size > 0 ? tokens : null;
  } catch {
    // gh not installed, not authenticated, or no open PR for this branch.
    return null;
  }
}

function fileListOverlaps(filePaths: unknown, recentFiles: Set<string>): boolean {
  if (!Array.isArray(filePaths)) return false;
  return filePaths.some((candidate) => {
    if (typeof candidate !== "string") return false;
    if (recentFiles.has(candidate)) return true;
    const base = candidate.split("/").pop();
    for (const recent of recentFiles) {
      if (recent.split("/").pop() === base) return true;
    }
    return false;
  });
}

// Plain-text, no ids/scores/box-drawing — meant to be injected directly
// into a Claude Code SessionStart hook's context, not read by a human at
// a terminal (that's the default, non---hook rendering below).
function printStartHookOutput(
  project: string,
  pinnedMemories: any[],
  unpinnedMemories: any[],
  budgetedFixes: { problem: string; solution: string | null }[]
): void {
  console.log(`# Project memory: ${project}`);

  if (pinnedMemories.length > 0) {
    console.log("");
    console.log("## Pinned");
    for (const memory of pinnedMemories) {
      console.log(`- ${memory.content}`);
    }
  }

  for (const type of MEMORY_TYPES) {
    const group = unpinnedMemories.filter((m) => m.type === type);
    if (group.length === 0) continue;

    console.log("");
    console.log(`## ${TYPE_LABELS[type]}`);
    for (const memory of group) {
      console.log(`- ${memory.content}`);
    }
  }

  if (budgetedFixes.length > 0) {
    console.log("");
    console.log("## Past Fixes");
    for (const fix of budgetedFixes) {
      console.log(`- ${fix.problem} -> ${fix.solution ?? "(pending)"}`);
    }
  }
}

// Mirrors cmdStart's ranking (decay + pinned + task-aware boosts) against
// local-store.ts instead of Supabase. No memory_links (that table has no
// local-store equivalent — a display enhancement, not core behavior) and
// no access_count persistence step is skipped either way for parity.
async function cmdStartLocal(project: string, hookMode: boolean): Promise<void> {
  const memories = localListMemories(project);
  if (memories.length === 0) {
    if (!hookMode) {
      console.log(`No memories found for "${project}". (local)`);
    }
    return;
  }

  const branchTokens = getBranchNameTokens();
  const recentFiles = getRecentlyTouchedFiles();
  const prTitleTokens = getOpenPrTitleTokens();
  const config = readStackmemConfig();
  const tokenBudget = config.tokenBudget;

  const scoredMemories = memories
    .map((memory) => {
      let decayScore = computeDecayScore(
        parseUtcDate(memory.created_at),
        memory.access_count ?? 0,
        memory.pinned ?? false,
        config.decayLambda
      );
      const contentTokens = tokenize(memory.content);
      if (branchTokens && hasTokenOverlap(contentTokens, branchTokens)) decayScore *= BRANCH_NAME_BOOST;
      if (recentFiles && fileListOverlaps(memory.file_paths, recentFiles)) decayScore *= RECENT_FILES_BOOST;
      if (prTitleTokens && hasTokenOverlap(contentTokens, prTitleTokens)) decayScore *= PR_TITLE_BOOST;
      return { ...memory, decay_score: decayScore };
    })
    .sort((a, b) => b.decay_score - a.decay_score);

  const budgetedMemories = applyContextBudget(scoredMemories, tokenBudget);
  const fixes = localListFixes(project).slice(0, 5);

  if (hookMode) {
    printStartHookOutput(
      project,
      budgetedMemories.filter((m) => m.pinned),
      budgetedMemories.filter((m) => !m.pinned),
      fixes
    );
    localIncrementAccessCounts(budgetedMemories.map((m) => m.id));
    return;
  }

  console.log(`Loaded ${scoredMemories.length} memory(ies) for "${project}". (local)\n`);

  const pinnedMemories = budgetedMemories.filter((m) => m.pinned);
  const unpinnedMemories = budgetedMemories.filter((m) => !m.pinned);

  if (pinnedMemories.length > 0) {
    console.log(`Pinned (${pinnedMemories.length})`);
    console.log("-".repeat(11));
    for (const memory of pinnedMemories) {
      console.log(`  [${memory.id}] (${memory.type}) ${memory.content}`);
    }
    console.log("");
  }

  for (const type of MEMORY_TYPES) {
    const group = unpinnedMemories.filter((m) => m.type === type);
    if (group.length === 0) continue;

    console.log(`${TYPE_LABELS[type]} (${group.length})`);
    console.log("-".repeat(TYPE_LABELS[type].length + 4));
    for (const memory of group) {
      console.log(`  [${memory.id}] (score: ${memory.decay_score.toFixed(2)}) ${memory.content}`);
    }
    console.log("");
  }

  if (fixes.length > 0) {
    console.log(`Past Fixes (${fixes.length})`);
    console.log("-".repeat(14));
    for (const fix of fixes) {
      console.log(`  Problem: ${fix.problem}`);
      console.log(`  Solution: ${fix.solution ?? "(pending)"}`);
      console.log("");
    }
  }

  localIncrementAccessCounts(budgetedMemories.map((m) => m.id));
}

async function cmdStart(project: string, hookMode = false, localMode = false) {
  void trackEvent("session_start");
  void maybeTrackDailyActive();

  if (localMode) {
    return cmdStartLocal(project, hookMode);
  }

  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .eq("resolved", false)
    .eq("suggested", false);

  if (error) fail(`Failed to load memories: ${error.message}`);

  const memories = data ?? [];
  if (memories.length === 0) {
    if (!hookMode) {
      console.log(`No memories found for "${project}".`);
      console.log("");
      console.log("Tip: run 'cm init' to seed tech stack memories from your project files.");
    }
    return;
  }

  // Task-aware re-ranking: boost memories relevant to what's actively
  // being worked on, multiplicatively on top of the base decay score.
  // Every signal degrades to null (no boost, not an error) if the
  // repo/branch/gh state it needs isn't available.
  const branchTokens = getBranchNameTokens();
  const recentFiles = getRecentlyTouchedFiles();
  const prTitleTokens = getOpenPrTitleTokens();

  const config = readStackmemConfig();
  const tokenBudget = config.tokenBudget;

  const scoredMemories = memories
    .map((memory) => {
      let decayScore = computeDecayScore(
        parseUtcDate(memory.created_at),
        memory.access_count ?? 0,
        memory.pinned ?? false,
        config.decayLambda
      );

      const contentTokens = tokenize(memory.content);
      if (branchTokens && hasTokenOverlap(contentTokens, branchTokens)) {
        decayScore *= BRANCH_NAME_BOOST;
      }
      if (recentFiles && fileListOverlaps(memory.file_paths, recentFiles)) {
        decayScore *= RECENT_FILES_BOOST;
      }
      if (prTitleTokens && hasTokenOverlap(contentTokens, prTitleTokens)) {
        decayScore *= PR_TITLE_BOOST;
      }

      return { ...memory, decay_score: decayScore };
    })
    .sort((a, b) => b.decay_score - a.decay_score);

  const budgetedMemories = applyContextBudget(scoredMemories, tokenBudget);
  const omittedCount = scoredMemories.length - budgetedMemories.length;
  let tokensUsed = budgetedMemories.reduce(
    (sum, memory) => sum + estimateTokens(memory.content),
    0
  );

  const { data: fixData, error: fixError } = await supabase
    .from("execution_log")
    .select("*")
    .eq("project", project)
    .eq("resolved", false)
    .order("created_at", { ascending: false })
    .limit(5);

  if (fixError) fail(`Failed to load execution log: ${fixError.message}`);

  // Fixes share the same token budget as memories, which already consumed
  // their portion above — fixes only get whatever room is left.
  const budgetedFixes: { problem: string; solution: string | null }[] = [];
  for (const fix of fixData ?? []) {
    const tokens = estimateTokens(`${fix.problem} ${fix.solution ?? ""}`);
    if (tokensUsed + tokens > tokenBudget) break;
    budgetedFixes.push(fix);
    tokensUsed += tokens;
  }

  const memoryIds = budgetedMemories.map((m) => m.id);
  const linkedIdsByMemory = new Map<string, Set<string>>();

  const idList = memoryIds.join(",");
  const { data: links, error: linksError } = await supabase
    .from("memory_links")
    .select("source_id, target_id")
    .or(`source_id.in.(${idList}),target_id.in.(${idList})`);

  if (linksError) fail(`Failed to load memory links: ${linksError.message}`);

  for (const link of links ?? []) {
    if (!linkedIdsByMemory.has(link.source_id)) linkedIdsByMemory.set(link.source_id, new Set());
    if (!linkedIdsByMemory.has(link.target_id)) linkedIdsByMemory.set(link.target_id, new Set());
    linkedIdsByMemory.get(link.source_id)!.add(link.target_id);
    linkedIdsByMemory.get(link.target_id)!.add(link.source_id);
  }

  const pinnedMemories = budgetedMemories.filter((m) => m.pinned);
  const unpinnedMemories = budgetedMemories.filter((m) => !m.pinned);

  if (hookMode) {
    printStartHookOutput(project, pinnedMemories, unpinnedMemories, budgetedFixes);
  } else {
    console.log(`Loaded ${scoredMemories.length} memory(ies) for "${project}".\n`);

    if (pinnedMemories.length > 0) {
      console.log(`Pinned (${pinnedMemories.length})`);
      console.log("-".repeat(11));
      for (const memory of pinnedMemories) {
        console.log(`  [${memory.id}] (${memory.type}) ${memory.content}`);
        const linked = Array.from(linkedIdsByMemory.get(memory.id) ?? []);
        if (linked.length > 0) {
          console.log(`      linked: ${linked.join(", ")}`);
        }
      }
      console.log("");
    }

    for (const type of MEMORY_TYPES) {
      const group = unpinnedMemories.filter((m) => m.type === type);
      if (group.length === 0) continue;

      console.log(`${TYPE_LABELS[type]} (${group.length})`);
      console.log("-".repeat(TYPE_LABELS[type].length + 4));
      for (const memory of group) {
        console.log(`  [${memory.id}] (score: ${memory.decay_score.toFixed(2)}) ${memory.content}`);
        const linked = Array.from(linkedIdsByMemory.get(memory.id) ?? []);
        if (linked.length > 0) {
          console.log(`      linked: ${linked.join(", ")}`);
        }
      }
      console.log("");
    }

    if (budgetedFixes.length > 0) {
      console.log(`Past Fixes (${budgetedFixes.length})`);
      console.log("-".repeat(14));
      for (const fix of budgetedFixes) {
        console.log(`  Problem: ${fix.problem}`);
        console.log(`  Solution: ${fix.solution ?? "(pending)"}`);
        console.log("");
      }
    }

    console.log(`Context budget: ${tokensUsed}/${tokenBudget} tokens used`);
    if (omittedCount > 0) {
      console.log(`${omittedCount} memories omitted (budget exceeded)`);
    }

    const hasTechStackMemory = memories.some((m) => /^tech stack:/i.test(m.content));
    if (!hasTechStackMemory) {
      console.log("");
      console.log("Tip: run 'cm init' to seed tech stack memories from your project files.");
    }
  }

  const incrementResults = await Promise.all(
    budgetedMemories.map((memory) =>
      supabase
        .from("memories")
        .update({ access_count: (memory.access_count ?? 0) + 1 })
        .eq("id", memory.id)
    )
  );
  const incrementError = incrementResults.find((result) => result.error)?.error;
  if (incrementError) fail(`Failed to update access counts: ${incrementError.message}`);
}

// --- cm save -------------------------------------------------------------

// Prompts on stdin before superseding — cm save runs interactively, unlike
// the MCP save_memory tool, which must supersede automatically since it has
// no user attached to ask.
async function confirmSupersede(oldId: string, newContent: string): Promise<boolean> {
  const { data: oldMemory, error } = await supabase
    .from("memories")
    .select("content")
    .eq("id", oldId)
    .single();

  if (error || !oldMemory) fail(`Failed to load superseded memory: ${error?.message ?? "not found"}`);

  console.log(`Conflict detected:\n  Old: ${oldMemory.content}\n  New: ${newContent}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Keep old or replace? (k/r): ")).trim().toLowerCase();
  rl.close();

  if (answer === "k") {
    console.log("Kept original memory.");
    return false;
  }
  if (answer === "r") {
    return true;
  }
  console.log("Invalid input — kept original memory.");
  return false;
}

// Provenance metadata attached to a memory at save time. Manual `cm save`
// calls (a human at the keyboard) leave this at its defaults — source
// "manual", confidence 1.0, no commit/file/author info. The hook passes
// commitSha/filePaths/author and source "hook" with a lower confidence;
// MCP tool saves pass source "mcp".
interface SaveProvenance {
  commitSha?: string;
  filePaths?: string[];
  author?: string;
  source?: "hook" | "manual" | "mcp";
  confidence?: number;
}

// Reuses decideSaveAction/redactSecrets from scoring.ts unchanged — only
// the storage layer (local-store.ts vs. supabase) differs from cmdSave.
// No network calls, no memory_links computation (that's a ranking/display
// enhancement, not core save behavior — out of scope for a quick local
// fallback).
async function cmdSaveLocal(project: string, type: string, content: string): Promise<void> {
  if (!MEMORY_TYPES.includes(type as MemoryType)) {
    fail(`Invalid memory type '${type}'. Valid types: decision, constraint, discovery, rejection.`);
  }
  if (content.length > 500) {
    fail(
      `Memory content too long (${content.length} chars). Keep memories under 500 characters — they should be concise facts, not paragraphs.`
    );
  }

  content = redactSecrets(content);

  const existing = localListMemories(project);
  const decision = decideSaveAction(content, existing);

  if (decision.action === "duplicate") {
    console.log("Duplicate memory detected — skipping. (local)");
    return;
  }

  if (decision.action === "superseded") {
    localResolveMemory(decision.oldId);
  }

  const memory = localSaveMemory(project, type, content);
  if (decision.action === "superseded") {
    console.log(`Replaced with new memory [${memory.id}]. (local)`);
  }
  console.log(`Saved ${type} [${memory.id}] for "${project}". (local)`);
}

async function cmdSave(
  project: string,
  type: string,
  content: string,
  force = false,
  provenance: SaveProvenance = {},
  localMode = false
) {
  if (localMode) {
    return cmdSaveLocal(project, type, content);
  }

  if (!MEMORY_TYPES.includes(type as MemoryType)) {
    fail(`Invalid memory type '${type}'. Valid types: decision, constraint, discovery, rejection.`);
  }

  if (content.length > 500) {
    fail(
      `Memory content too long (${content.length} chars). Keep memories under 500 characters — they should be concise facts, not paragraphs.`
    );
  }

  // Redacted before any further use — comparisons, prompts, and storage all
  // see the scrubbed text, so a secret never round-trips through a console
  // prompt (confirmSupersede) or ends up persisted.
  content = redactSecrets(content);

  const { data: existingRows, error: existingError } = await supabase
    .from("memories")
    .select("id, content")
    .eq("project", project)
    .eq("resolved", false);

  if (existingError) fail(`Failed to load memories: ${existingError.message}`);

  const existingMemories = existingRows ?? [];
  const decision = decideSaveAction(content, existingMemories);

  if (decision.action === "duplicate") {
    console.log("Duplicate memory detected — skipping.");
    return;
  }

  if (decision.action === "superseded" && !force) {
    const shouldSupersede = await confirmSupersede(decision.oldId, content);
    if (!shouldSupersede) return;
  }

  if (decision.action === "superseded") {
    const { error: resolveError } = await supabase
      .from("memories")
      .update({ resolved: true })
      .eq("id", decision.oldId);

    if (resolveError) fail(`Failed to resolve superseded memory: ${resolveError.message}`);
  }

  const { commitSha, filePaths, author, source = "manual", confidence = 1.0 } = provenance;
  const insertPayload: Record<string, unknown> = {
    project,
    type,
    content,
    device_id: getDeviceId(),
    source,
    confidence,
    // Hook-captured memories are heuristically detected and could be
    // noisy or wrong — they start as suggested, pending `cm review`, and
    // are excluded from cm start/context/why until promoted. Manual and
    // mcp saves are already user-vetted, so they're permanent immediately.
    // readStackmemConfig().suggestedReview (set via `cm init --wizard`)
    // lets a project opt out of the review queue entirely.
    suggested: source === "hook" && readStackmemConfig().suggestedReview,
  };
  if (commitSha) insertPayload.commit_sha = commitSha;
  if (filePaths && filePaths.length > 0) insertPayload.file_paths = filePaths;
  if (author) insertPayload.author = author;

  const { data: inserted, error } = await supabase
    .from("memories")
    .insert(insertPayload)
    .select("id")
    .single();

  if (error || !inserted) fail(`Failed to save memory: ${error?.message ?? "no row returned"}`);

  const newMemoryId = inserted.id;
  const links = computeMemoryLinks(newMemoryId, content, existingMemories);

  if (links.length > 0) {
    const { error: linkError } = await supabase.from("memory_links").insert(links);
    if (linkError) fail(`Failed to save memory links: ${linkError.message}`);
  }

  if (decision.action === "superseded") {
    console.log(`Replaced with new memory [${newMemoryId}].`);
  }

  console.log(`Saved ${type} [${newMemoryId}] for "${project}".`);
  if (links.length > 0) {
    console.log(`Linked to ${links.length} existing memory(ies): ${links.map((l) => l.target_id).join(", ")}`);
  }

  const { count: unresolvedCount, error: countError } = await supabase
    .from("memories")
    .select("id", { count: "exact", head: true })
    .eq("project", project)
    .eq("resolved", false);

  if (countError) fail(`Failed to count memories: ${countError.message}`);

  if ((unresolvedCount ?? 0) >= COMPRESSION_THRESHOLD) {
    await compressMemories(project);
  }
}

// --- cm check-commit (internal, used by the hook) --------------------------

// Not a user-facing command (no usage()/help entry) — the hook calls this
// once per invocation, before doing any diff analysis, to decide whether
// this commit_sha has already been captured. post-commit and post-rewrite
// both run the exact same capture logic against current HEAD, so without
// this guard, a commit that fires both hooks (e.g. `git commit --amend`,
// which triggers post-commit for the new commit AND post-rewrite for the
// rewrite) would be captured twice. Checked once per invocation — not
// inside each individual cmSave call — because a single commit normally
// produces several distinct memories; a per-save check would see the
// first save's own commit_sha and wrongly skip the rest.
async function cmdCheckCommit(project: string, commitSha: string): Promise<void> {
  const { data, error } = await supabase
    .from("memories")
    .select("id")
    .eq("project", project)
    .eq("commit_sha", commitSha)
    .limit(1);

  if (error) {
    // Fail open: an error here (including "column does not exist" if the
    // commit_sha migration hasn't landed yet) must not look identical to
    // "duplicate, skip" below — that would silently suppress every hook
    // capture with no log trail. Exit 0 so the normal save path runs;
    // if commit_sha genuinely isn't a column, the save itself fails
    // there instead, where the hook's outer error handler logs it.
    console.error(`check-commit: ${error.message}`);
    process.exit(0);
  }

  process.exit(data && data.length > 0 ? 1 : 0);
}

// --- memory compression ----------------------------------------------------

async function compressMemories(
  project: string
): Promise<{ totalUnresolved: number; clustersCompressed: number }> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .eq("resolved", false)
    .eq("suggested", false);

  if (error) fail(`Failed to load memories for compression: ${error.message}`);

  const memories = data ?? [];
  if (memories.length < COMPRESSION_THRESHOLD) {
    return { totalUnresolved: memories.length, clustersCompressed: 0 };
  }

  const clusters = clusterMemories(memories);
  let clustersCompressed = 0;

  for (const cluster of clusters) {
    if (cluster.length < 3) continue;

    const summaryContent = buildSummaryContent(cluster);
    const { error: insertError } = await supabase
      .from("memories")
      .insert({ project, type: "discovery", content: summaryContent, device_id: getDeviceId() });

    if (insertError) fail(`Failed to insert summary memory: ${insertError.message}`);

    const idsToResolve = cluster.map((memory) => memory.id);
    const { error: resolveError } = await supabase
      .from("memories")
      .update({ resolved: true })
      .in("id", idsToResolve);

    if (resolveError) fail(`Failed to resolve compressed memories: ${resolveError.message}`);

    console.log(`Compressed ${cluster.length} memories into 1 summary`);
    clustersCompressed++;
  }

  console.log(`Compression complete. ${clustersCompressed} clusters compressed.`);
  return { totalUnresolved: memories.length, clustersCompressed };
}

// --- cm compress -------------------------------------------------------

async function cmdCompress(project: string) {
  const result = await compressMemories(project);
  if (result.totalUnresolved < COMPRESSION_THRESHOLD) {
    console.log(
      `Not enough memories to compress (need ${COMPRESSION_THRESHOLD}+, have ${result.totalUnresolved}).`
    );
  }
}

// --- cm fix --------------------------------------------------------------

async function cmdFix(project: string, problem: string, solution: string, localMode = false) {
  if (problem.trim().length === 0 || solution.trim().length === 0) {
    fail("Problem and solution cannot be empty.");
  }

  problem = redactSecrets(problem);
  solution = redactSecrets(solution);

  if (localMode) {
    localSaveFix(project, problem, solution);
    console.log(`Fix recorded for "${project}". (local)`);
    return;
  }

  const { error } = await supabase
    .from("execution_log")
    .insert({ project, problem, solution, resolved: false, device_id: getDeviceId() });

  if (error) fail(`Failed to record fix: ${error.message}`);

  console.log(`Fix recorded for "${project}".`);
}

// --- cm analyze ------------------------------------------------------------

async function cmdAnalyze(project: string, path: string) {
  void project;
  const summary = analyzeCodebase(path);
  console.log(`Indexed ${summary.files_indexed} file(s):`);
  console.log(`  functions: ${summary.functions}`);
  console.log(`  classes:   ${summary.classes}`);
}

// --- cm search -------------------------------------------------------------

function printSearchResults(
  memoryResults: { id: string; type: string; content: string }[],
  fixResults: { problem: string; solution: string | null }[],
  suffix: string
): void {
  if (memoryResults.length === 0 && fixResults.length === 0) {
    console.log(`No results found${suffix}`);
    return;
  }

  console.log(`Memories (${memoryResults.length})${suffix}`);
  console.log("-".repeat(11));
  if (memoryResults.length === 0) {
    console.log("No results found");
  } else {
    for (const memory of memoryResults) {
      console.log(`  [${memory.id}] (${memory.type}) ${memory.content}`);
    }
  }
  console.log("");

  console.log(`Past Fixes (${fixResults.length})${suffix}`);
  console.log("-".repeat(14));
  if (fixResults.length === 0) {
    console.log("No results found");
  } else {
    for (const fix of fixResults) {
      console.log(`  Problem:  ${fix.problem}`);
      console.log(`  Solution: ${fix.solution}`);
      console.log("");
    }
  }
}

// A plain substring search (case-insensitive) against local-store.ts —
// the SQL ilike wildcard search has no local equivalent, so this is the
// simplest faithful match.
function cmdSearchLocal(project: string, query: string): void {
  const lowerQuery = query.toLowerCase();
  const memoryResults = localListMemories(project).filter((m) =>
    m.content.toLowerCase().includes(lowerQuery)
  );
  const fixResults = localListFixes(project).filter(
    (f) => f.problem.toLowerCase().includes(lowerQuery) || (f.solution ?? "").toLowerCase().includes(lowerQuery)
  );
  printSearchResults(memoryResults, fixResults, " (local)");
}

async function cmdSearch(project: string, query: string, localMode = false) {
  if (localMode) {
    return cmdSearchLocal(project, query);
  }

  const { data: memories, error: memoriesError } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .ilike("content", `%${query}%`);

  if (memoriesError) fail(`Failed to search memories: ${memoriesError.message}`);

  const { data: fixes, error: fixesError } = await supabase
    .from("execution_log")
    .select("*")
    .eq("project", project)
    .or(`problem.ilike.%${query}%,solution.ilike.%${query}%`);

  if (fixesError) fail(`Failed to search past fixes: ${fixesError.message}`);

  const memoryResults = memories ?? [];
  const fixResults = fixes ?? [];

  if (memoryResults.length === 0 && fixResults.length === 0) {
    console.log("No results found");
    return;
  }

  console.log(`Memories (${memoryResults.length})`);
  console.log("-".repeat(11));
  if (memoryResults.length === 0) {
    console.log("No results found");
  } else {
    for (const memory of memoryResults) {
      console.log(`  [${memory.id}] (${memory.type}) ${memory.content}`);
    }
  }
  console.log("");

  console.log(`Past Fixes (${fixResults.length})`);
  console.log("-".repeat(14));
  if (fixResults.length === 0) {
    console.log("No results found");
  } else {
    for (const fix of fixResults) {
      console.log(`  Problem:  ${fix.problem}`);
      console.log(`  Solution: ${fix.solution}`);
      console.log("");
    }
  }
}

// --- cm resolve ------------------------------------------------------------

async function cmdResolve(project: string, memoryId: string) {
  const { data, error } = await supabase
    .from("memories")
    .update({ resolved: true })
    .eq("project", project)
    .eq("id", memoryId)
    .select("id");

  if (error) fail(`Failed to resolve memory: ${error.message}`);

  if (!data || data.length === 0) {
    console.log(`No memory found with ID [${memoryId}]`);
    return;
  }

  console.log(`Resolved memory [${memoryId}]`);
}

// --- cm pin / cm unpin -------------------------------------------------

async function setPinned(project: string, memoryId: string, pinned: boolean): Promise<void> {
  const { data, error } = await supabase
    .from("memories")
    .update({ pinned })
    .eq("project", project)
    .eq("id", memoryId)
    .select("id");

  if (error) fail(`Failed to ${pinned ? "pin" : "unpin"} memory: ${error.message}`);

  if (!data || data.length === 0) {
    console.log(`No memory found with ID [${memoryId}]`);
    return;
  }

  console.log(`${pinned ? "Pinned" : "Unpinned"} memory [${memoryId}]`);
}

async function cmdPin(project: string, memoryId: string): Promise<void> {
  await setPinned(project, memoryId, true);
}

async function cmdUnpin(project: string, memoryId: string): Promise<void> {
  await setPinned(project, memoryId, false);
}

// --- cm delete -------------------------------------------------------------

async function cmdDelete(project: string, memoryId: string) {
  const { error: linksError } = await supabase
    .from("memory_links")
    .delete()
    .or(`source_id.eq.${memoryId},target_id.eq.${memoryId}`);

  if (linksError) fail(`Failed to delete memory links: ${linksError.message}`);

  const { data, error } = await supabase
    .from("memories")
    .delete()
    .eq("project", project)
    .eq("id", memoryId)
    .select("id");

  if (error) fail(`Failed to delete memory: ${error.message}`);

  if (!data || data.length === 0) {
    console.log(`No memory found with ID [${memoryId}]`);
    return;
  }

  console.log(`Deleted memory [${memoryId}]`);
}

// --- shared: relative time + $EDITOR prompt (cm review, cm edit, cm status)

function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// Opens $EDITOR on a scratch file pre-filled with the current content, or
// falls back to an inline readline prompt when $EDITOR isn't set. Returns
// the original content unchanged if the result is blank (an empty save
// buffer almost certainly means "I didn't mean to clear this", not "make
// this memory empty").
async function editContentInteractively(currentContent: string): Promise<string> {
  const editor = process.env.EDITOR;

  if (editor) {
    const tmpFile = nodePath.join(nodeOs.tmpdir(), `stackmem-edit-${randomInt(1_000_000_000)}.txt`);
    nodeFs.writeFileSync(tmpFile, currentContent, "utf-8");
    try {
      execFileSync(editor, [tmpFile], { stdio: "inherit" });
      const edited = nodeFs.readFileSync(tmpFile, "utf-8").trim();
      return edited.length > 0 ? edited : currentContent;
    } finally {
      try {
        nodeFs.unlinkSync(tmpFile);
      } catch {
        // Best-effort cleanup — a leftover temp file isn't worth failing on.
      }
    }
  }

  console.log(`Current: ${currentContent}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("New content (leave blank to keep unchanged): ")).trim();
  rl.close();
  return answer.length > 0 ? answer : currentContent;
}

// --- cm review -------------------------------------------------------------

// --- shared: multi-prompt readline over TTY or piped stdin ---------------

interface Prompter {
  ask(prompt: string): Promise<string>;
  close(): void;
}

// Node's readline can't reliably answer multiple sequential
// rl.question() calls over piped (non-TTY) stdin — all buffered input
// arrives before the second question is even issued, and the pending
// question never resolves. A real interactive terminal doesn't hit this
// (keystrokes arrive one at a time), so only the non-TTY path needs the
// read-everything-up-front workaround: pre-read every line and hand them
// out from a queue instead of calling rl.question() again per prompt.
async function createPrompter(): Promise<Prompter> {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return {
      ask: (prompt) => rl.question(prompt),
      close: () => rl.close(),
    };
  }

  const raw = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf));
  });
  const queued = raw.split("\n");

  return {
    ask: async (prompt) => {
      console.log(prompt);
      return queued.shift() ?? "";
    },
    close: () => {},
  };
}

async function promptYesNo(prompter: Prompter, question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? "(y/n, default y)" : "(y/n, default n)";
  const answer = (await prompter.ask(`${question} ${suffix}: `)).trim().toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

async function cmdReview(project: string): Promise<void> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .eq("resolved", false)
    .eq("suggested", true)
    .order("created_at", { ascending: true });

  if (error) fail(`Failed to load suggested memories: ${error.message}`);

  const memories = data ?? [];
  if (memories.length === 0) {
    console.log(`No memories to review for "${project}".`);
    console.log("Your inbox is empty.");
    return;
  }

  console.log(`Reviewing ${memories.length} suggested memories for "${project}"`);
  console.log("━".repeat(40));

  const prompter = await createPrompter();

  // A blank answer (real Enter keypress, or piped input running dry) falls
  // through to the "s"/unrecognized branch below and is counted as
  // skipped — the for loop is bounded by memories.length either way, so
  // there's no risk of looping forever on exhausted piped input.
  async function nextAnswer(prompt: string): Promise<string> {
    return (await prompter.ask(prompt)).trim().toLowerCase();
  }

  let kept = 0;
  let dropped = 0;
  let skipped = 0;

  for (let i = 0; i < memories.length; i++) {
    const memory = memories[i];
    console.log(`[${i + 1}/${memories.length}] ${memory.type}: ${memory.content}`);
    console.log(`      Captured: ${formatRelativeTime(parseUtcDate(memory.created_at))}`);
    console.log("");

    const answer = await nextAnswer("(k)eep  (e)dit  (d)rop  (s)kip  (q)uit > ");
    console.log("");

    if (answer === "k") {
      const { error: updateError } = await supabase
        .from("memories")
        .update({ suggested: false })
        .eq("id", memory.id);
      if (!updateError) kept++;
    } else if (answer === "e") {
      const newContent = redactSecrets(await editContentInteractively(memory.content));
      const { error: updateError } = await supabase
        .from("memories")
        .update({ content: newContent, suggested: false })
        .eq("id", memory.id);
      if (!updateError) kept++;
    } else if (answer === "d") {
      await supabase
        .from("memory_links")
        .delete()
        .or(`source_id.eq.${memory.id},target_id.eq.${memory.id}`);
      const { error: deleteError } = await supabase.from("memories").delete().eq("id", memory.id);
      if (!deleteError) dropped++;
    } else if (answer === "q") {
      break;
    } else {
      // "s", blank, or anything unrecognized — leave it suggested and
      // move on rather than erroring on a mistyped key.
      skipped++;
    }
  }

  prompter.close();
  console.log(`Review complete. Kept ${kept}, dropped ${dropped}, skipped ${skipped}.`);
}

// --- cm edit ---------------------------------------------------------------

async function cmdEdit(project: string, memoryId: string): Promise<void> {
  const { data: memory, error } = await supabase
    .from("memories")
    .select("id, content")
    .eq("project", project)
    .eq("id", memoryId)
    .single();

  if (error || !memory) {
    console.log(`No memory found with ID [${memoryId}]`);
    return;
  }

  const newContent = redactSecrets(await editContentInteractively(memory.content));
  const { error: updateError } = await supabase
    .from("memories")
    .update({ content: newContent })
    .eq("id", memoryId);

  if (updateError) fail(`Failed to update memory: ${updateError.message}`);

  console.log(`Updated memory [${memoryId}].`);
}

// --- cm inspect ------------------------------------------------------------

function formatDate(dateString: string): string {
  return parseUtcDate(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

async function cmdInspect(project: string, memoryId: string) {
  const { data: memory, error } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .eq("id", memoryId)
    .single();

  if (error || !memory) fail(`Memory [${memoryId}] not found for "${project}".`);

  const config = readStackmemConfig();
  const decayScore = computeDecayScore(
    parseUtcDate(memory.created_at),
    memory.access_count ?? 0,
    memory.pinned ?? false,
    config.decayLambda
  );

  const { data: links, error: linksError } = await supabase
    .from("memory_links")
    .select("source_id, target_id, score")
    .or(`source_id.eq.${memoryId},target_id.eq.${memoryId}`);

  if (linksError) fail(`Failed to load memory links: ${linksError.message}`);

  const linkedEntries = (links ?? []).map((link) => ({
    linkedId: link.source_id === memoryId ? link.target_id : link.source_id,
    score: link.score,
  }));

  let linkedMemories: Array<{
    id: string;
    type: string;
    content: string;
    created_at: string;
    score: number;
  }> = [];

  if (linkedEntries.length > 0) {
    const linkedIds = linkedEntries.map((entry) => entry.linkedId);
    const { data: linkedRows, error: linkedError } = await supabase
      .from("memories")
      .select("id, type, content, created_at")
      .in("id", linkedIds);

    if (linkedError) fail(`Failed to load linked memories: ${linkedError.message}`);

    const scoreById = new Map(linkedEntries.map((entry) => [entry.linkedId, entry.score]));
    linkedMemories = (linkedRows ?? [])
      .map((row) => ({ ...row, score: scoreById.get(row.id) ?? 0 }))
      .sort((a, b) => b.score - a.score);
  }

  const entities = extractEntities(memory.content);
  const { data: fixes, error: fixesError } = await supabase
    .from("execution_log")
    .select("problem, solution")
    .eq("project", project);

  if (fixesError) fail(`Failed to load execution log: ${fixesError.message}`);

  const relatedFixes = (fixes ?? []).filter((fix) => {
    const fixEntities = extractEntities(`${fix.problem} ${fix.solution}`);
    for (const entity of entities) {
      if (fixEntities.has(entity)) return true;
    }
    return false;
  });

  const divider = "─".repeat(40);
  console.log(divider);
  console.log(
    `${memory.type.toUpperCase()} · accessed ${memory.access_count ?? 0}x · decay ${decayScore.toFixed(2)}`
  );
  console.log(divider);
  console.log(memory.content);
  console.log("");
  console.log(`Created: ${formatDate(memory.created_at)}`);
  console.log(`Status:  ${memory.resolved ? "resolved" : "unresolved"}`);
  console.log("");

  console.log(`LINKED MEMORIES (${linkedMemories.length})`);
  for (const linked of linkedMemories) {
    console.log(`  └─ [score: ${linked.score.toFixed(2)}] ${linked.type.toUpperCase()}`);
    console.log(`     ${linked.content}`);
    console.log(`     ${formatDate(linked.created_at)}`);
    console.log("");
  }

  if (relatedFixes.length > 0) {
    console.log(`RELATED FIXES (${relatedFixes.length})`);
    for (const fix of relatedFixes) {
      console.log(`  └─ FIX: ${fix.problem} → ${fix.solution}`);
    }
  }
}

// --- cm init -------------------------------------------------------------

// The hook logic lives in its own .mjs file (not directly in
// .git/hooks/post-commit) so its module type is unambiguous — an
// extensionless file run by git would otherwise have its CommonJS/ESM
// interpretation depend on the target repo's own package.json.
function buildHookLogicScript(cliPath: string): string {
  return `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// The hook must never block or break a commit: a slow or throwing hook body
// is worse than a skipped one. runHook() does the real work; main() races
// it against a 2s timeout and logs (rather than surfaces) any failure.
const HOOK_TIMEOUT_MS = 2000;

const stackmemPath = join(process.cwd(), ".stackmem");
let PROJECT;
try {
  PROJECT = readFileSync(stackmemPath, "utf8").trim();
} catch {
  process.exit(0); // no .stackmem, skip silently
}

const CLI_PATH = ${JSON.stringify(cliPath)};

// Inlined copy of src/config-file.ts's defaults/merge logic — this script
// runs standalone with no import access to that module.
const DEFAULT_STACKMEM_CONFIG = {
  ignore: [],
  tokenBudget: 2000,
  decayLambda: 0.05,
  captureTypes: ["decision", "constraint", "discovery", "rejection"],
  minQualityScore: 0.3,
};

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function readStackmemConfig() {
  const configPath = join(process.cwd(), ".stackmem.json");
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    return {
      ignore: isStringArray(raw.ignore) ? raw.ignore : DEFAULT_STACKMEM_CONFIG.ignore,
      tokenBudget:
        typeof raw.tokenBudget === "number" && raw.tokenBudget > 0
          ? raw.tokenBudget
          : DEFAULT_STACKMEM_CONFIG.tokenBudget,
      decayLambda:
        typeof raw.decayLambda === "number" && raw.decayLambda > 0
          ? raw.decayLambda
          : DEFAULT_STACKMEM_CONFIG.decayLambda,
      captureTypes: isStringArray(raw.captureTypes) ? raw.captureTypes : DEFAULT_STACKMEM_CONFIG.captureTypes,
      minQualityScore:
        typeof raw.minQualityScore === "number"
          ? raw.minQualityScore
          : DEFAULT_STACKMEM_CONFIG.minQualityScore,
    };
  } catch {
    return { ...DEFAULT_STACKMEM_CONFIG };
  }
}

function matchesIgnorePattern(filePath, pattern) {
  const base = filePath.split("/").pop() ?? filePath;

  if (pattern.endsWith("/")) {
    const dirName = pattern.slice(0, -1);
    return filePath.split("/").includes(dirName);
  }

  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.split("*").map((part) => part.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&")).join(".*") + "$"
    );
    return regex.test(base) || regex.test(filePath);
  }

  return filePath === pattern || base === pattern;
}

const STACKMEM_CONFIG = readStackmemConfig();

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,
  /(api[_-]?key|apikey)\\s*[:=]\\s*["']?[\\w-]{20,}["']?/gi,
  /bearer\\s+[a-zA-Z0-9\\-._~+/]+=*/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/g,
  /^[A-Z_]+=.{8,}/gm,
];

const HIGH_ENTROPY_RE = /[a-zA-Z0-9+/]{40,}={0,2}/g;
const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 4.5;

function shannonEntropy(text) {
  if (text.length === 0) return 0;
  const counts = new Map();
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

// Inlined copy of src/scoring.ts's redactSecrets — this script runs
// standalone via git's post-commit, with no import access to that module.
function redactSecrets(content) {
  let result = content;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  result = result.replace(HIGH_ENTROPY_RE, (match) =>
    shannonEntropy(match) > HIGH_ENTROPY_MIN_BITS_PER_CHAR ? "[REDACTED]" : match
  );
  return result;
}

function logHookError(error) {
  try {
    const logPath = join(process.cwd(), ".coding-memory", "hook.log");
    mkdirSync(dirname(logPath), { recursive: true });
    const message = error instanceof Error ? (error.stack || error.message) : String(error);
    appendFileSync(logPath, \`[\${new Date().toISOString()}] \${message}\\n\`);
  } catch {
    // Logging itself failed — nothing more we can safely do without
    // risking the commit, so give up silently.
  }
}

async function runHook() {

function git(args) {
  return execFileSync("git", args, { encoding: "utf-8" }).trim();
}

const CURRENT_SHA = git(["rev-parse", "HEAD"]);
const CURRENT_AUTHOR = (() => {
  try {
    return git(["log", "--format=%ae", "-1", "HEAD"]);
  } catch {
    return "";
  }
})();

// post-commit and post-rewrite both run this exact script against current
// HEAD, so a single operation that fires both (e.g. \`git commit --amend\`)
// would otherwise capture the same commit twice. Checked once up front,
// not per-save — see cmdCheckCommit in src/cli.ts for why.
try {
  execFileSync("node", [CLI_PATH, "check-commit", PROJECT, CURRENT_SHA], { stdio: "pipe" });
} catch {
  return;
}

// file_paths is populated with every file the commit touched (not just
// the filtered diffableFiles below) — "cm why <file>" should still find
// a commit's decision/discovery even if that specific file's own diff
// content was skipped as noise (a lockfile, say).
function cmSave(type, content) {
  if (!STACKMEM_CONFIG.captureTypes.includes(type)) return;

  const args = [
    CLI_PATH, "save", PROJECT, type, content, "--force",
    "--commit-sha", CURRENT_SHA,
    "--source", "hook",
    "--confidence", "0.8",
  ];
  if (CURRENT_AUTHOR) args.push("--author", CURRENT_AUTHOR);
  if (changedFiles.length > 0) args.push("--files", changedFiles.join(","));

  execFileSync("node", args, { stdio: "inherit" });
  savedItems.push(\`\${type}: \${content}\`);
}

function basename(filePath) {
  return filePath.split("/").pop() ?? filePath;
}

function isConfigFile(filePath) {
  const base = basename(filePath);
  return (
    /\\.config\\.(ts|js)$/.test(base) ||
    base.startsWith("docker-compose") ||
    base === "Dockerfile" ||
    base === "nginx.conf" ||
    base.startsWith(".eslintrc") ||
    base.startsWith(".prettierrc")
  );
}

function isSchemaFile(filePath) {
  return (
    /migration/i.test(filePath) ||
    filePath.includes("schema.prisma") ||
    filePath.includes("schema.sql")
  );
}

// Noise that's never worth diffing: lockfiles, build output, vendored/
// generated code, and timestamp-prefixed SQL migrations (their content is
// a mechanical dump, not a human decision). Checked against path segments
// (not just a prefix) so "apps/web/dist/bundle.js" is skipped too, not
// just a top-level "dist/...".
const DIFF_SKIP_DIR_NAMES = new Set(["dist", "build", ".next", "coverage", "vendored", "node_modules"]);
const DIFF_SKIP_LOCK_NAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const MIGRATION_FILE_RE = /^\\d{14}_.*\\.sql$/;
const DIFF_MAX_BYTES = 50 * 1024;

function shouldSkipDiffFile(filePath) {
  const base = basename(filePath);
  if (filePath.split("/").some((segment) => DIFF_SKIP_DIR_NAMES.has(segment))) return true;
  if (DIFF_SKIP_LOCK_NAMES.has(base) || base.endsWith(".lock")) return true;
  if (base.endsWith(".min.js") || base.endsWith(".min.css")) return true;
  if (base.endsWith(".map")) return true;
  if (base.endsWith(".pb.go")) return true;
  if (/\\.generated\\./.test(base)) return true;
  if (MIGRATION_FILE_RE.test(base)) return true;
  if (STACKMEM_CONFIG.ignore.some((pattern) => matchesIgnorePattern(filePath, pattern))) return true;
  return false;
}

const LOW_QUALITY_PREFIXES = [
  "wip", "fix", "update", "misc", "temp", "test", "patch", "minor",
  "tweak", "change", "stuff", "done", "commit", "save", "ok", "m", "x",
];

const SEMVER_RE = /^\\d+\\.\\d+\\.\\d+$/;

// Filters out lazy/placeholder commit messages ("wip", "fix", "m", "...")
// and bare version bumps ("1.0.4") so only messages worth remembering
// become decisions. Checked against the first word, not a raw prefix
// match, so a real message like "Migrate auth to JWT" isn't rejected just
// for starting with the letter "m".
function isQualityCommitMessage(message) {
  const trimmed = message.trim();
  if (trimmed.length < 15) return false;
  if (SEMVER_RE.test(trimmed)) return false;
  if (!trimmed.includes(" ")) return false;

  const stripped = trimmed.replace(/\\s/g, "");
  if (stripped.length > 0 && new Set(stripped).size === 1) return false;

  const lowerTrimmed = trimmed.toLowerCase();
  if (LOW_QUALITY_PREFIXES.includes(lowerTrimmed)) return false;

  const firstWord = (lowerTrimmed.match(/^[a-z0-9]+/) || [""])[0];
  if (LOW_QUALITY_PREFIXES.includes(firstWord)) return false;

  return true;
}

const savedItems = [];

const commitMessage = git(["log", "-1", "--pretty=%B"]);

// Kept as a general escape hatch for other automation (CI bots, scripts)
// that tags its own commits this way and shouldn't be captured as a
// memory — cm sync no longer self-commits, so this isn't load-bearing for
// that anymore, but other tools' commits still deserve the same skip.
if (commitMessage.includes("[skip ci]")) {
  return;
}

const isFirstCommit = (() => {
  try {
    execFileSync("git", ["rev-parse", "HEAD~1"], { stdio: "pipe" });
    return false;
  } catch {
    return true;
  }
})();

const changedFiles = git(
  isFirstCommit
    ? ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", "HEAD"]
    : ["diff-tree", "--no-commit-id", "-r", "--name-only", "HEAD"]
)
  .split("\\n")
  .filter(Boolean);

let diff = "";
if (!isFirstCommit) {
  // --numstat marks a binary file's added/deleted columns as "-" — that's
  // the cheapest way to identify them without fetching their (useless,
  // and potentially huge) diff content at all.
  let binaryFiles = new Set();
  try {
    const numstat = execFileSync("git", ["diff", "--numstat", "HEAD~1", "HEAD"], {
      encoding: "utf-8",
    });
    for (const line of numstat.split("\\n")) {
      const parts = line.split("\\t");
      if (parts[0] === "-" && parts[1] === "-" && parts[2]) {
        binaryFiles.add(parts[2]);
      }
    }
  } catch {
    // Nothing to compare against — leave binaryFiles empty.
  }

  const diffableFiles = changedFiles.filter(
    (file) => !binaryFiles.has(file) && !shouldSkipDiffFile(file)
  );

  if (diffableFiles.length > 0) {
    try {
      diff = execFileSync("git", ["diff", "HEAD~1", "HEAD", "--", ...diffableFiles], {
        encoding: "utf-8",
      });
    } catch {
      diff = "";
    }
  }

  if (diff.length > DIFF_MAX_BYTES) {
    diff = diff.slice(0, DIFF_MAX_BYTES) + "\\n\\n... [diff truncated: exceeded 50KB after filtering]\\n";
  }
}

const lines = diff.split("\\n");
let currentFile = null;
let isNewFile = false;
let inDependenciesSection = false;

for (const line of isFirstCommit ? [] : lines) {
  if (line.startsWith("diff --git")) {
    isNewFile = false;
    inDependenciesSection = false;
  }
  if (line.startsWith("new file mode")) {
    isNewFile = true;
  }

  if (line.startsWith("+++ ")) {
    let filePath = line.slice(4);
    if (filePath.startsWith("b/")) filePath = filePath.slice(2);
    currentFile = filePath;

    if (isNewFile) {
      if (/(auth|login|session|token)/i.test(currentFile)) {
        const content = redactSecrets(\`new auth-related file: \${currentFile}\`);
        cmSave("discovery", content);
      }
      if (isConfigFile(currentFile)) {
        const content = redactSecrets(\`new config: \${currentFile}\`);
        cmSave("constraint", content);
      }
      if (isSchemaFile(currentFile)) {
        const content = redactSecrets(\`schema change: \${currentFile}\`);
        cmSave("discovery", content);
      }
    }
    continue;
  }

  const isPackageJson = currentFile != null && basename(currentFile) === "package.json";
  if (isPackageJson) {
    const rawLine =
      line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")
        ? line.slice(1)
        : line;
    if (/"(dependencies|devDependencies)"\\s*:\\s*\\{/.test(rawLine)) {
      inDependenciesSection = true;
    } else if (inDependenciesSection && /^\\s*\\}/.test(rawLine)) {
      inDependenciesSection = false;
    }
  }

  if (line.startsWith("-") && !line.startsWith("---")) {
    const codeLine = line.slice(1).trim();

    const importMatch = line.match(
      /^-\\s*(import\\s+.*\\s+from\\s+['"]([^'"]+)['"]|import\\s+['"]([^'"]+)['"])/
    );
    const requireMatch = line.match(
      /^-\\s*(?:const|let|var)\\s+\\S+\\s*=\\s*require\\(['"]([^'"]+)['"]\\)/
    );
    const removedModulePath = importMatch
      ? importMatch[2] || importMatch[3]
      : requireMatch
        ? requireMatch[1]
        : null;

    if (removedModulePath) {
      const content = redactSecrets(\`removed dependency: \${removedModulePath}\`);
      cmSave("rejection", content);
    }

    if (isPackageJson && inDependenciesSection) {
      const pkgMatch = codeLine.match(/"([a-z][\\w-]+)"\\s*:/);
      if (pkgMatch && pkgMatch[1] !== "dependencies" && pkgMatch[1] !== "devDependencies") {
        const content = redactSecrets(\`removed dependency: \${pkgMatch[1]}\`);
        cmSave("rejection", content);
      }
    }
    continue;
  }

  if (line.startsWith("+") && !line.startsWith("+++")) {
    const codeLine = line.slice(1);

    if (currentFile) {
      const base = basename(currentFile);
      if (base === ".env" || base === ".env.example") {
        const envMatch = codeLine.match(/([A-Z_]{3,})=/);
        if (envMatch) {
          const content = redactSecrets(\`new env var required: \${envMatch[1]}\`);
          cmSave("constraint", content);
        }
      }
    }

    if (isPackageJson && inDependenciesSection) {
      const pkgMatch = codeLine.match(/"([a-z][\\w-]+)"\\s*:/);
      if (pkgMatch && pkgMatch[1] !== "dependencies" && pkgMatch[1] !== "devDependencies") {
        const content = redactSecrets(\`added dependency: \${pkgMatch[1]}\`);
        cmSave("decision", content);
      }
    }

    if (currentFile && isSchemaFile(currentFile) && /CREATE TABLE|ALTER TABLE|DROP TABLE/i.test(codeLine)) {
      const truncated = codeLine.trim().slice(0, 80);
      const content = redactSecrets(\`database change: \${truncated}\`);
      cmSave("discovery", content);
    }

    if (/^\\+\\s*(\\/\\/|#)\\s*(TODO:|FIXME:|HACK:|XXX:)/.test(line)) {
      const truncated = codeLine.trim().slice(0, 100);
      const content = redactSecrets(\`open issue from commit: \${truncated}\`);
      cmSave("discovery", content);
    }
  }
}

// Conventional-commit routing (handled last, after every diff-detected
// memory — diff analysis always runs regardless of commit message):
// feat/fix/perf/refactor save as a decision outright (the "type:" prefix is
// itself the quality signal, so the generic filter below is bypassed);
// docs/style/test/ci/build/chore are skipped entirely; a BREAKING CHANGE
// footer always saves as a constraint, independent of (and in addition to)
// the type-based routing above; anything that isn't a recognized
// conventional-commit type at all falls back to the pre-existing
// isQualityCommitMessage filter.
const CONVENTIONAL_COMMIT_RE = /^([a-zA-Z]+)(\\([^)]*\\))?!?:\\s*(.+)/;
const CONVENTIONAL_DECISION_TYPES = new Set(["feat", "fix", "perf", "refactor"]);
const CONVENTIONAL_SKIP_TYPES = new Set(["docs", "style", "test", "ci", "build", "chore"]);
const BREAKING_CHANGE_RE = /BREAKING CHANGE:\\s*([\\s\\S]+?)(?:\\n\\n|$)/;

const trimmedCommitMessage = commitMessage.trim();
const commitFirstLine = trimmedCommitMessage.split("\\n")[0];
const conventionalMatch = commitFirstLine.match(CONVENTIONAL_COMMIT_RE);
const conventionalType = conventionalMatch ? conventionalMatch[1].toLowerCase() : null;

const breakingMatch = trimmedCommitMessage.match(BREAKING_CHANGE_RE);
if (breakingMatch) {
  const breakingContent = redactSecrets(breakingMatch[1].trim());
  const content = \`BREAKING CHANGE: \${breakingContent}\`;
  cmSave("constraint", content);
}

if (conventionalType && CONVENTIONAL_DECISION_TYPES.has(conventionalType)) {
  const trimmedMessage = redactSecrets(trimmedCommitMessage);
  cmSave("decision", trimmedMessage);
} else if (conventionalType && CONVENTIONAL_SKIP_TYPES.has(conventionalType)) {
  // docs/style/test/ci/build/chore — skip entirely, nothing saved.
} else if (isQualityCommitMessage(commitMessage)) {
  const trimmedMessage = redactSecrets(trimmedCommitMessage);
  cmSave("decision", trimmedMessage);
}

console.log(\`coding-memory post-commit summary (\${changedFiles.length} file(s) changed):\`);
for (const item of savedItems) {
  console.log(\`  - \${item}\`);
}

// Updates .cursorrules/.windsurfrules on disk only — no git add/commit.
// Editors read these files straight off disk, and they're gitignored by
// default (see DEFAULT_GITIGNORE_CONTENT), so there's nothing to keep in
// sync with git history; committing them here used to double the commit
// count on every real commit and produced constant rules-file merge
// conflicts on teams.
execFileSync("node", [CLI_PATH, "sync"], { stdio: "inherit" });
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
`;
}

// Hooks stackmem manages. post-rewrite fires on `git commit --amend` and
// `git rebase` (neither of which is a plain commit, so post-commit alone
// misses them) — it runs the exact same capture script as post-commit,
// against current HEAD, with the check-commit idempotency guard in the
// script itself preventing a double-capture when a single operation
// (e.g. --amend) fires both hooks for the same resulting commit.
const MANAGED_HOOK_NAMES = ["post-commit", "post-rewrite"] as const;

function hookBackupFilename(hookName: string): string {
  return `${hookName}${HOOK_BACKUP_SUFFIX}`;
}

// Installs (or re-installs) a stackmem-managed hook at `hooksDir`. If a
// hook of this name already exists and wasn't written by stackmem, it's
// preserved as a backup and chained to run before stackmem's own hook,
// rather than being clobbered — see `uninstallHook` for how it's restored.
function installHook(hooksDir: string, hookLogicPath: string, hookName: string): void {
  nodeFs.mkdirSync(hooksDir, { recursive: true });

  const hookPath = nodePath.join(hooksDir, hookName);
  const backupPath = nodePath.join(hooksDir, hookBackupFilename(hookName));

  let chainedOriginal = false;
  if (nodeFs.existsSync(hookPath)) {
    const existingContent = nodeFs.readFileSync(hookPath, "utf-8");
    if (!existingContent.includes(STACKMEM_HOOK_MARKER)) {
      nodeFs.copyFileSync(hookPath, backupPath);
      try {
        nodeFs.chmodSync(backupPath, 0o755);
      } catch {
        // Best-effort — if the original wasn't executable either, leave it.
      }
      chainedOriginal = true;
    }
  }

  // Git for Windows bundles its own POSIX-ish shell and generally runs a
  // #!/bin/sh hook fine through it — but per the task's explicit ask,
  // win32 gets a native .cmd-style wrapper instead, as a belt-and-suspenders
  // compatibility layer rather than relying on that. Untested on an actual
  // Windows machine; if the chained original hook isn't itself a Windows
  // batch/cmd/ps1 script, `call` below won't be able to run it correctly.
  const isWindows = process.platform === "win32";

  if (isWindows) {
    const chainLine = chainedOriginal ? `call "%~dp0${hookBackupFilename(hookName)}"\n` : "";
    nodeFs.writeFileSync(
      hookPath,
      `@echo off\r\nREM ${STACKMEM_HOOK_MARKER}\r\n${chainLine}node "${hookLogicPath}" %*\r\n`,
      "utf-8"
    );
  } else {
    const chainLine = chainedOriginal
      ? `"$(dirname "$0")/${hookBackupFilename(hookName)}" "$@"\n`
      : "";
    nodeFs.writeFileSync(
      hookPath,
      `#!/bin/sh\n${STACKMEM_HOOK_MARKER}\n${chainLine}exec node "${hookLogicPath}" "$@"\n`,
      "utf-8"
    );
  }
  nodeFs.chmodSync(hookPath, 0o755);

  if (chainedOriginal) {
    console.log(`Existing ${hookName} hook found — chained it to run before stackmem's hook.`);
  }
}

// Reverses `installHook`: if stackmem wrote the hook fresh, removes it; if
// stackmem chained it after an existing hook, restores that original hook
// in its place. Returns a description of what happened, or null if there
// was no stackmem-managed hook to remove (nothing done).
function uninstallHook(hooksDir: string, hookName: string): string | null {
  const hookPath = nodePath.join(hooksDir, hookName);
  const backupPath = nodePath.join(hooksDir, hookBackupFilename(hookName));

  if (!nodeFs.existsSync(hookPath)) return null;

  const content = nodeFs.readFileSync(hookPath, "utf-8");
  if (!content.includes(STACKMEM_HOOK_MARKER)) return null;

  if (nodeFs.existsSync(backupPath)) {
    nodeFs.renameSync(backupPath, hookPath);
    return `.git/hooks/${hookName} (restored original hook stackmem had chained)`;
  }

  nodeFs.unlinkSync(hookPath);
  return `.git/hooks/${hookName}`;
}

// Overridable so tests (and `cm uninstall`'s own smoke-testing) can point
// at a scratch file instead of the real ~/.claude.json.
function getClaudeConfigPath(): string {
  return nodePath.join(nodeOs.homedir(), ".claude.json");
}

function registerMcpServer(distIndexPath: string, claudeConfigPath = getClaudeConfigPath()): void {
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (nodeFs.existsSync(claudeConfigPath)) {
    try {
      config = JSON.parse(nodeFs.readFileSync(claudeConfigPath, "utf-8"));
    } catch {
      config = {};
    }
  }

  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }

  if (config.mcpServers.stackmem) {
    return;
  }

  config.mcpServers.stackmem = {
    command: "node",
    args: [distIndexPath],
  };

  nodeFs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), "utf-8");
  console.log("stackmem MCP server registered with Claude Code.");
}

// Returns true if an entry was actually removed.
function unregisterMcpServer(claudeConfigPath = getClaudeConfigPath()): boolean {
  if (!nodeFs.existsSync(claudeConfigPath)) return false;

  let config: { mcpServers?: Record<string, unknown> } = {};
  try {
    config = JSON.parse(nodeFs.readFileSync(claudeConfigPath, "utf-8"));
  } catch {
    return false;
  }

  if (!config.mcpServers || !("stackmem" in config.mcpServers)) return false;

  delete config.mcpServers.stackmem;
  nodeFs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), "utf-8");
  return true;
}

// --- MCP registration for other editors ---------------------------------

// Each entry detects its editor by an existing config directory (never
// erroring if absent — "skip silently" per the task) and merges stackmem
// into whatever's already there, same spirit as registerMcpServer above.
// homeDir is a parameter (not a hardcoded nodeOs.homedir() call) so tests
// can point at a scratch directory instead of the real one.
interface EditorMcpTarget {
  name: string;
  configPath: (homeDir: string) => string | null;
  register: (configPath: string, distIndexPath: string) => void;
}

function mergeMcpServersJson(configPath: string, distIndexPath: string): void {
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (nodeFs.existsSync(configPath)) {
    try {
      config = JSON.parse(nodeFs.readFileSync(configPath, "utf-8"));
    } catch {
      config = {};
    }
  }
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }
  config.mcpServers.stackmem = { command: "node", args: [distIndexPath] };

  nodeFs.mkdirSync(nodePath.dirname(configPath), { recursive: true });
  nodeFs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

// VS Code installs the Copilot Chat extension under a version-suffixed
// directory name (e.g. "github.copilot-chat-0.26.4") — this resolves the
// "github.copilot-chat*" glob the task describes against whatever's
// actually installed, rather than assuming a fixed folder name.
function findCopilotChatExtensionDir(homeDir: string): string | null {
  const extensionsDir = nodePath.join(homeDir, ".vscode", "extensions");
  if (!nodeFs.existsSync(extensionsDir)) return null;

  try {
    const match = nodeFs
      .readdirSync(extensionsDir)
      .find((entry) => entry.startsWith("github.copilot-chat"));
    return match ? nodePath.join(extensionsDir, match) : null;
  } catch {
    return null;
  }
}

const EDITOR_MCP_TARGETS: EditorMcpTarget[] = [
  {
    name: "Cursor",
    configPath: (homeDir) => {
      const dir = nodePath.join(homeDir, ".cursor");
      return nodeFs.existsSync(dir) ? nodePath.join(dir, "mcp.json") : null;
    },
    register: mergeMcpServersJson,
  },
  {
    name: "Windsurf",
    configPath: (homeDir) => {
      const dir = nodePath.join(homeDir, ".codeium", "windsurf");
      return nodeFs.existsSync(dir) ? nodePath.join(dir, "mcp_config.json") : null;
    },
    register: mergeMcpServersJson,
  },
  {
    name: "VS Code (Copilot)",
    configPath: (homeDir) => {
      const extensionDir = findCopilotChatExtensionDir(homeDir);
      return extensionDir ? nodePath.join(extensionDir, "mcp.json") : null;
    },
    register: mergeMcpServersJson,
  },
  {
    name: "Zed",
    configPath: (homeDir) => {
      const dir = nodePath.join(homeDir, ".config", "zed");
      return nodeFs.existsSync(dir) ? nodePath.join(dir, "settings.json") : null;
    },
    register: (configPath, distIndexPath) => {
      let config: { context_servers?: Record<string, unknown> } = {};
      if (nodeFs.existsSync(configPath)) {
        try {
          config = JSON.parse(nodeFs.readFileSync(configPath, "utf-8"));
        } catch {
          config = {};
        }
      }
      if (!config.context_servers || typeof config.context_servers !== "object") {
        config.context_servers = {};
      }
      config.context_servers.stackmem = { command: "node", args: [distIndexPath] };
      nodeFs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    },
  },
];

// Registers stackmem's MCP server with every detected editor, printing a
// line per success. An editor whose config directory doesn't exist is
// skipped with no output and never an error.
function registerEditorMcpServers(distIndexPath: string, homeDir = nodeOs.homedir()): void {
  for (const target of EDITOR_MCP_TARGETS) {
    const configPath = target.configPath(homeDir);
    if (!configPath) continue;

    try {
      target.register(configPath, distIndexPath);
      console.log(`✓ MCP registered for ${target.name}`);
    } catch {
      // Best-effort — a permissions error or malformed existing config on
      // one editor shouldn't abort `cm init` or the other editors' writes.
    }
  }
}

const DEFAULT_GITIGNORE_CONTENT = `node_modules/
dist/
.env
.env.local
.DS_Store
*.log
coverage/
*-memories.json
*.db
*cursorrules
*windsurfrules
.cursor/rules/stackmem.md
.coding-memory/local-store.json
`;

// Returns true if the file was created, false if it already existed
// (and was left untouched).
function writeGitignore(resolvedPath: string): boolean {
  const gitignorePath = nodePath.join(resolvedPath, ".gitignore");

  if (nodeFs.existsSync(gitignorePath)) {
    return false;
  }

  nodeFs.writeFileSync(gitignorePath, DEFAULT_GITIGNORE_CONTENT, "utf-8");
  return true;
}

function writeClaudeMd(project: string, resolvedPath: string): void {
  const claudeMdPath = nodePath.join(resolvedPath, "CLAUDE.md");

  if (nodeFs.existsSync(claudeMdPath)) {
    console.log("CLAUDE.md already exists — skipping.");
    return;
  }

  const content = `# stackmem

At the start of every session, the stackmem MCP server will automatically load memories for this project. The project name is "${project}".

If the MCP server is not connected, run:
cm start ${project}
and paste the output here before starting work.

When you make a decision, discover a constraint, reject an approach, or make a discovery during this session, save it with:
cm save ${project} <type> "<content>"
`;

  nodeFs.writeFileSync(claudeMdPath, content, "utf-8");
  console.log("CLAUDE.md written.");
}

// Same instructional purpose as writeClaudeMd — point the agent at
// `cm start` rather than embedding a memory snapshot directly, since a
// baked-in snapshot goes stale the moment the next commit lands. AGENTS.md
// is the convention used by OpenAI Codex CLI, Gemini CLI, and others;
// GEMINI.md is Gemini CLI's own equivalent — both get identical content.
function writeAgentsMemoryFile(project: string, resolvedPath: string, filename: string): void {
  const filePath = nodePath.join(resolvedPath, filename);

  if (nodeFs.existsSync(filePath)) {
    console.log(`${filename} already exists — skipping.`);
    return;
  }

  const content = `# ${project} — Agent Memory

This project uses stackmem for persistent agent memory.
Run \`cm start ${project}\` at the start of every session
to load relevant context.

## Key decisions, constraints and discoveries

Decisions, constraints, discoveries, and rejections live in the stackmem
backend, not duplicated in this file — run \`cm start ${project}\` to load
the current list.

When you make a decision, discover a constraint, reject an approach, or
make a discovery during this session, save it with:
cm save ${project} <type> "<content>"
`;

  nodeFs.writeFileSync(filePath, content, "utf-8");
  console.log(`${filename} written.`);
}

// --- Claude Code hooks (.claude/settings.json) ------------------------

interface ClaudeHookHandler {
  type: string;
  command: string;
}

interface ClaudeHookGroup {
  matcher?: string;
  hooks: ClaudeHookHandler[];
}

interface ClaudeSettingsFile {
  hooks?: Record<string, ClaudeHookGroup[]>;
  [key: string]: unknown;
}

// --project (not positional) for the PreCompact command below: cmdContext's
// CLI convention takes --project like cm search/cm context already do
// everywhere else — cm start and cm session-end both take a positional
// project, so those two keep the user's literal command shape.
const STACKMEM_HOOK_EVENTS: { event: string; buildCommand: (project: string) => string }[] = [
  { event: "SessionStart", buildCommand: (project) => `cm start ${project} --hook` },
  { event: "Stop", buildCommand: (project) => `cm session-end ${project} --hook` },
  { event: "PreCompact", buildCommand: (project) => `cm context --project ${project} --hook` },
];

// Writes (or merges into) <resolvedPath>/.claude/settings.json. Merges
// rather than overwrites — an existing settings.json may have unrelated
// hooks or settings that must survive this — and is idempotent: re-running
// `cm init` checks for the exact command string already present in an
// event's hook groups before adding another one.
function writeClaudeCodeHooks(project: string, resolvedPath: string): void {
  const settingsDir = nodePath.join(resolvedPath, ".claude");
  const settingsPath = nodePath.join(settingsDir, "settings.json");

  let settings: ClaudeSettingsFile = {};
  if (nodeFs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(nodeFs.readFileSync(settingsPath, "utf-8"));
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }

  for (const { event, buildCommand } of STACKMEM_HOOK_EVENTS) {
    const command = buildCommand(project);

    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
    }

    const alreadyRegistered = settings.hooks[event].some(
      (group) => Array.isArray(group?.hooks) && group.hooks.some((h) => h?.command === command)
    );

    if (!alreadyRegistered) {
      settings.hooks[event].push({ hooks: [{ type: "command", command }] });
    }
  }

  nodeFs.mkdirSync(settingsDir, { recursive: true });
  nodeFs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

// Section order for the generated rules-file markdown — matches the order
// memories are presented in everywhere else (cm context's CONTEXT_TYPE_ORDER),
// not MEMORY_TYPES' declaration order.
const RULES_FILE_TYPE_ORDER: MemoryType[] = ["decision", "constraint", "rejection", "discovery"];

// Builds the markdown written into .cursorrules / .windsurfrules: the
// project's unresolved memories (decay-ranked, budget-capped so an
// editor's system prompt never balloons) plus its most recent open fixes.
// Shared by `cm init` (first write) and `cm sync` (refresh on every commit).
async function generateRulesContent(project: string): Promise<string> {
  const { data: memoryRows, error: memoriesError } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .eq("resolved", false)
    .eq("suggested", false);

  if (memoriesError) fail(`Failed to load memories: ${memoriesError.message}`);

  const config = readStackmemConfig();
  const scoredMemories = (memoryRows ?? [])
    .map((memory) => ({
      ...memory,
      decay_score: computeDecayScore(
        parseUtcDate(memory.created_at),
        memory.access_count ?? 0,
        memory.pinned ?? false,
        config.decayLambda
      ),
    }))
    .sort((a, b) => b.decay_score - a.decay_score);

  const budgetedMemories = applyContextBudget(scoredMemories, CONTEXT_BUDGET_TOKENS);

  const { data: fixRows, error: fixesError } = await supabase
    .from("execution_log")
    .select("*")
    .eq("project", project)
    .eq("resolved", false)
    .order("created_at", { ascending: false })
    .limit(5);

  if (fixesError) fail(`Failed to load execution log: ${fixesError.message}`);

  const fixes = fixRows ?? [];

  const lines: string[] = [];
  lines.push("# stackmem — project memory (auto-updated)");
  lines.push(`## Project: ${project}`);

  if (budgetedMemories.length === 0 && fixes.length === 0) {
    lines.push("");
    lines.push("No memories yet. Make a commit to start capturing.");
  } else {
    for (const type of RULES_FILE_TYPE_ORDER) {
      const group = budgetedMemories.filter((memory) => memory.type === type);
      if (group.length === 0) continue;

      lines.push("");
      lines.push(`### ${TYPE_LABELS[type]}`);
      for (const memory of group) {
        lines.push(`- ${memory.content}`);
      }
    }

    if (fixes.length > 0) {
      lines.push("");
      lines.push("### Recent Fixes");
      for (const fix of fixes) {
        const solution = fix.solution && fix.solution.trim().length > 0
          ? fix.solution
          : "(solution pending)";
        lines.push(`- ${fix.problem} → ${solution}`);
      }
    }
  }

  lines.push("");
  lines.push("---");
  lines.push(`*Last updated: ${new Date().toLocaleString("en-US")}*`);
  lines.push("*Run `cm start` for full details with decay scores*");
  lines.push("");

  return lines.join("\n");
}

// Returns true if the file was written, false if it already existed
// (and was skipped).
function writeCursorRules(resolvedPath: string, content: string): boolean {
  const cursorRulesPath = nodePath.join(resolvedPath, ".cursorrules");

  if (nodeFs.existsSync(cursorRulesPath)) {
    console.log(".cursorrules already exists — skipping.");
    return false;
  }

  nodeFs.writeFileSync(cursorRulesPath, content, "utf-8");
  console.log(".cursorrules written.");
  return true;
}

// Cursor's newer rules format (.cursor/rules/*.md) — .cursorrules is
// legacy but still read by older Cursor versions, so both are written
// during the transition rather than one replacing the other. Unlike
// writeCursorRules/writeWindsurfRules (write-once at init, skip if
// present), this one unconditionally overwrites on every call — both at
// init and on every `cm sync` — since it's gitignored content meant to
// always reflect the current memory state, same as the legacy files.
function writeCursorRulesMdFile(resolvedPath: string, content: string): void {
  const rulesDir = nodePath.join(resolvedPath, ".cursor", "rules");
  nodeFs.mkdirSync(rulesDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(rulesDir, "stackmem.md"), content, "utf-8");
}

// Returns true if the file was written, false if it already existed
// (and was skipped).
function writeWindsurfRules(resolvedPath: string, content: string): boolean {
  const windsurfRulesPath = nodePath.join(resolvedPath, ".windsurfrules");

  if (nodeFs.existsSync(windsurfRulesPath)) {
    console.log(".windsurfrules already exists — skipping.");
    return false;
  }

  nodeFs.writeFileSync(windsurfRulesPath, content, "utf-8");
  console.log(".windsurfrules written.");
  return true;
}

function writeProjectFile(project: string, resolvedPath: string): void {
  const stackmemPath = nodePath.join(resolvedPath, STACKMEM_FILE);
  nodeFs.writeFileSync(stackmemPath, `${project}\n`, "utf-8");
}

// Minimal shape trySeedMemory needs from a Supabase client — narrow enough
// that tests can pass a mock without satisfying the full SupabaseClient type.
interface MemoryInsertClient {
  from(table: string): { insert(row: unknown): PromiseLike<{ error: unknown }> };
}

// Shared by every seedMemories check below: skip the insert if this exact
// content already exists (decideSaveAction's duplicate check) so re-running
// `cm init` on an already-seeded project doesn't pile up repeats. Exported,
// with an injectable client, so this duplicate-prevention guarantee is
// unit-testable without a live Supabase connection.
export async function trySeedMemory(
  project: string,
  existingMemories: { id: string; content: string }[],
  type: MemoryType,
  content: string,
  client: MemoryInsertClient = supabase
): Promise<boolean> {
  const decision = decideSaveAction(content, existingMemories);
  if (decision.action === "duplicate") return false;

  const { error } = await client.from("memories").insert({
    project,
    type,
    content,
    device_id: getDeviceId(),
    // Seeded by `cm init` scanning project files — an explicit user-run
    // command, not an auto-captured commit, so it's "manual" like cm save,
    // not the memories.source column's default of "hook".
    source: "manual",
  });
  return !error;
}

// Scans the freshly-initialized project for a few cheap, high-signal facts
// and saves them as memories directly (bypassing cmdSave's duplicate/conflict
// prompt — there's nothing to conflict with yet, and init must stay
// non-interactive). Returns how many memories were actually saved.
async function seedMemories(project: string, resolvedPath: string): Promise<number> {
  let seededCount = 0;

  const { data: existingRows, error: existingError } = await supabase
    .from("memories")
    .select("id, content")
    .eq("project", project)
    .eq("resolved", false);

  if (existingError) fail(`Failed to load memories: ${existingError.message}`);

  const existingMemories = existingRows ?? [];

  const packageJsonPath = nodePath.join(resolvedPath, "package.json");
  if (nodeFs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(nodeFs.readFileSync(packageJsonPath, "utf-8"));
      const depNames = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ];
      if (depNames.length > 0) {
        const content = `tech stack: ${depNames.join(", ")}`;
        if (await trySeedMemory(project, existingMemories, "discovery", content)) seededCount++;
      }
    } catch {
      // Malformed package.json — skip the tech-stack memory.
    }
  }

  const envExamplePath = nodePath.join(resolvedPath, ".env.example");
  if (nodeFs.existsSync(envExamplePath)) {
    const varNames = nodeFs
      .readFileSync(envExamplePath, "utf-8")
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => line.split("=")[0]);

    if (varNames.length > 0) {
      const content = `required env vars: ${varNames.join(", ")}`;
      if (await trySeedMemory(project, existingMemories, "constraint", content)) seededCount++;
    }
  }

  const tsconfigPath = nodePath.join(resolvedPath, "tsconfig.json");
  if (nodeFs.existsSync(tsconfigPath)) {
    try {
      const tsconfig = JSON.parse(nodeFs.readFileSync(tsconfigPath, "utf-8"));
      const target = tsconfig.compilerOptions?.target;
      const moduleKind = tsconfig.compilerOptions?.module;
      if (target || moduleKind) {
        const content = `TypeScript config: target=${target ?? "unspecified"}, module=${moduleKind ?? "unspecified"}`;
        if (await trySeedMemory(project, existingMemories, "constraint", content)) seededCount++;
      }
    } catch {
      // Malformed tsconfig.json (or JSONC with comments) — skip.
    }
  }

  const readmePath = nodePath.join(resolvedPath, "README.md");
  if (nodeFs.existsSync(readmePath)) {
    const words = nodeFs
      .readFileSync(readmePath, "utf-8")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 100);
    if (words.length > 0) {
      const content = `project description: ${words.join(" ")}`;
      if (await trySeedMemory(project, existingMemories, "discovery", content)) seededCount++;
    }
  }

  const FRAMEWORK_FILE_INDICATORS: { file: string; type: MemoryType; content: string }[] = [
    { file: "next.config.ts", type: "constraint", content: "framework: Next.js" },
    { file: "next.config.js", type: "constraint", content: "framework: Next.js" },
    { file: "vite.config.ts", type: "constraint", content: "framework: Vite" },
    { file: "vite.config.js", type: "constraint", content: "framework: Vite" },
    { file: "Dockerfile", type: "constraint", content: "containerized: Docker" },
  ];
  for (const indicator of FRAMEWORK_FILE_INDICATORS) {
    if (!nodeFs.existsSync(nodePath.join(resolvedPath, indicator.file))) continue;
    if (await trySeedMemory(project, existingMemories, indicator.type, indicator.content)) seededCount++;
  }

  const githubWorkflowsPath = nodePath.join(resolvedPath, ".github", "workflows");
  if (nodeFs.existsSync(githubWorkflowsPath)) {
    const content = "CI/CD: GitHub Actions";
    if (await trySeedMemory(project, existingMemories, "discovery", content)) seededCount++;
  }

  analyzeCodebase(resolvedPath);

  return seededCount;
}

// Smoke-tests the same anon-key + device-header path session_start/cmdStart
// use, without pulling in all of cmdStart's scoring/formatting logic.
async function verifyBackendConnection(project: string): Promise<boolean> {
  const { error } = await supabase
    .from("memories")
    .select("id", { count: "exact", head: true })
    .eq("project", project);

  return !error;
}

// Returns true if the file was created, false if it already existed
// (and was left untouched).
function writeStackmemConfigFile(resolvedPath: string): boolean {
  const configPath = nodePath.join(resolvedPath, STACKMEM_CONFIG_FILENAME);

  if (nodeFs.existsSync(configPath)) {
    return false;
  }

  nodeFs.writeFileSync(configPath, defaultConfigFileContents(), "utf-8");
  return true;
}

// --- cm init --wizard ----------------------------------------------------

const WIZARD_EDITOR_CHOICES = ["Claude Code", "Cursor", "Windsurf", "VS Code", "Zed"] as const;

function detectDefaultProjectName(resolvedPath: string): string {
  try {
    const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(resolvedPath, "package.json"), "utf-8"));
    if (typeof pkg.name === "string" && pkg.name.trim().length > 0) return pkg.name.trim();
  } catch {
    // No package.json, or no "name" field — fall back to the directory name.
  }
  return nodePath.basename(resolvedPath);
}

// --wizard is a separate entry point from the non-interactive cmdInit path
// on purpose — regression/integration tests exercise plain `cm init`
// unprompted, and must stay that way. This just collects preferences via
// readline, then drives the same cmdInit everything else already uses.
//
// "Which editors do you use? (space to select)" from the task description
// is a checkbox-style multi-select, which needs raw keypress handling
// (arrow keys + space to toggle) that plain readline doesn't provide
// without pulling in a TUI dependency — this asks for a comma-separated
// list of numbers instead. Functionally equivalent, just typed instead
// of toggled.
async function cmdInitWizard(targetPath: string): Promise<void> {
  const resolvedPath = nodePath.resolve(targetPath);
  const prompter = await createPrompter();

  try {
    console.log("Welcome to stackmem! Let's set up your project.");
    console.log("");

    const detectedName = detectDefaultProjectName(resolvedPath);
    const projectAnswer = (
      await prompter.ask(`Project name [${detectedName}] (press enter to accept, or type a new name): `)
    ).trim();
    const project = projectAnswer.length > 0 ? projectAnswer : detectedName;

    console.log("");
    console.log("Which editors do you use? Enter the numbers, comma-separated (e.g. 1,2):");
    WIZARD_EDITOR_CHOICES.forEach((name, i) => console.log(`  [${i + 1}] ${name}`));
    const editorsAnswer = (await prompter.ask("> ")).trim();
    const selectedEditors = editorsAnswer
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => n >= 1 && n <= WIZARD_EDITOR_CHOICES.length)
      .map((n) => WIZARD_EDITOR_CHOICES[n - 1]);

    console.log("");
    const suggestedReview = await promptYesNo(
      prompter,
      "Enable suggested memory review? Hook captures start as suggested, pending `cm review`, instead of permanent immediately.",
      true
    );

    console.log("");
    const createConfig = await promptYesNo(prompter, "Create .stackmem.json config?", true);

    console.log("");
    const telemetryOptIn = await promptYesNo(
      prompter,
      "Help improve stackmem? Send anonymous usage stats (no code, no memories).",
      false
    );
    if (telemetryOptIn) {
      enableTelemetry();
    }

    console.log("");
    console.log("Setting up stackmem...");
    console.log("");

    await cmdInit(project, targetPath, createConfig);

    // suggestedReview: false has to persist even if the user declined a
    // full config file — otherwise their answer is silently discarded.
    // A full config write already includes it at its chosen value; a
    // declined one still gets a minimal file with just this field.
    if (!suggestedReview) {
      const configPath = nodePath.join(resolvedPath, STACKMEM_CONFIG_FILENAME);
      if (createConfig) {
        const config = JSON.parse(nodeFs.readFileSync(configPath, "utf-8"));
        config.suggestedReview = false;
        nodeFs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
      } else if (!nodeFs.existsSync(configPath)) {
        nodeFs.writeFileSync(configPath, JSON.stringify({ suggestedReview: false }, null, 2), "utf-8");
      }
    }

    console.log("");
    console.log("Getting started:");
    console.log(`  Project: ${project}`);
    console.log(
      `  Editors: ${selectedEditors.length > 0 ? selectedEditors.join(", ") : "(none selected — MCP still auto-registers for whichever are actually installed)"}`
    );
    console.log(`  Suggested memory review: ${suggestedReview ? "enabled" : "disabled"}`);
    console.log(`  .stackmem.json: ${createConfig || !suggestedReview ? "written" : "not created"}`);
    console.log(`  Anonymous usage stats: ${telemetryOptIn ? "enabled" : "disabled"}`);
    console.log("");
    console.log(`Run 'cm start ${project}' any time to load what stackmem knows about this project.`);
  } finally {
    prompter.close();
  }
}

async function cmdInit(project: string, targetPath: string, writeConfig = false): Promise<void> {
  const resolvedPath = nodePath.resolve(targetPath);
  const gitDir = nodePath.join(resolvedPath, ".git");

  if (!nodeFs.existsSync(gitDir)) {
    console.error(`No git repo found at ${targetPath}. Run 'git init' first, then run 'cm init' again.`);
    process.exit(1);
  }

  const gitignoreCreated = writeGitignore(resolvedPath);

  const codingMemoryDir = nodePath.join(resolvedPath, ".coding-memory");
  nodeFs.mkdirSync(codingMemoryDir, { recursive: true });

  const hookLogicPath = nodePath.join(codingMemoryDir, "post-commit-hook.mjs");
  nodeFs.writeFileSync(hookLogicPath, buildHookLogicScript(DIST_CLI_PATH), "utf-8");

  const hooksDir = nodePath.join(gitDir, "hooks");
  nodeFs.mkdirSync(hooksDir, { recursive: true });

  for (const hookName of MANAGED_HOOK_NAMES) {
    installHook(hooksDir, hookLogicPath, hookName);
  }

  console.log(`coding-memory hook installed for project ${project} at ${targetPath}`);

  registerMcpServer(DIST_INDEX_PATH);
  registerEditorMcpServers(DIST_INDEX_PATH);
  writeClaudeMd(project, resolvedPath);
  writeAgentsMemoryFile(project, resolvedPath, "AGENTS.md");
  writeAgentsMemoryFile(project, resolvedPath, "GEMINI.md");
  writeClaudeCodeHooks(project, resolvedPath);

  const seededCount = await seedMemories(project, resolvedPath);
  console.log(`Seeded ${seededCount} initial memories from project scan.`);

  const rulesContent = await generateRulesContent(project);
  const cursorRulesWritten = writeCursorRules(resolvedPath, rulesContent);
  const windsurfRulesWritten = writeWindsurfRules(resolvedPath, rulesContent);
  writeCursorRulesMdFile(resolvedPath, rulesContent);

  const backendOk = await verifyBackendConnection(project);

  const configFileWritten = writeConfig ? writeStackmemConfigFile(resolvedPath) : false;

  console.log("");
  if (gitignoreCreated) {
    console.log("✓ .gitignore created");
  }
  if (writeConfig) {
    console.log(`✓ .stackmem.json ${configFileWritten ? "written" : "already exists"}`);
  }
  console.log("✓ Git hook installed");
  console.log("✓ MCP server registered");
  console.log("✓ Claude Code hooks registered (.claude/settings.json)");
  console.log("✓ CLAUDE.md written");
  console.log("✓ AGENTS.md written");
  console.log("✓ GEMINI.md written");
  console.log(
    `✓ .cursorrules ${cursorRulesWritten ? "written" : "already exists"}`
  );
  console.log(
    `✓ .windsurfrules ${windsurfRulesWritten ? "written" : "already exists"}`
  );
  console.log("✓ .cursor/rules/stackmem.md written");
  console.log(`✓ Seeded ${seededCount} memories from project scan`);
  if (backendOk) {
    console.log("✓ Backend connection verified");
    console.log("");
    console.log(
      `stackmem is live. Open Claude Code and ask "what do you know about this project?" to verify.`
    );
  } else {
    console.log("✗ Backend connection failed — run 'cm doctor'");
  }

  // Written last and deliberately: if a commit (and hence the post-commit
  // hook) fires anywhere during init, it must still see whatever project
  // .stackmem pointed to before this run, not the one being initialized now.
  writeProjectFile(project, resolvedPath);

  void trackEvent("init");
}

// --- cm sync ---------------------------------------------------------------

async function cmdSync(project: string) {
  const resolvedPath = process.cwd();
  const rulesContent = await generateRulesContent(project);

  nodeFs.writeFileSync(nodePath.join(resolvedPath, ".cursorrules"), rulesContent, "utf-8");
  nodeFs.writeFileSync(nodePath.join(resolvedPath, ".windsurfrules"), rulesContent, "utf-8");
  writeCursorRulesMdFile(resolvedPath, rulesContent);

  console.log("Synced memories to .cursorrules, .windsurfrules, and .cursor/rules/stackmem.md");
}

// --- cm link ---------------------------------------------------------------

// Mirrors the link_codes.expires_at default in the migration
// (supabase/migrations/001_user_devices_and_link_codes.sql in the vault repo).
// If that interval changes, change this too — polling past expires_at just
// burns requests against a row the API will refuse.
const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const LINK_POLL_INTERVAL_MS = 3_000;
const LINK_CODE_INSERT_ATTEMPTS = 5;
const PG_UNIQUE_VIOLATION = "23505";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// randomInt is a CSPRNG and uniform over the range. Math.random() would do
// neither, and a link code is a short-lived credential for claiming this
// device's memories — a guessable one is a hijack.
function generateLinkCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

async function cmdLink() {
  const deviceId = getDeviceId();

  // A 6-digit space collides rarely, but only unclaimed codes occupy it and
  // the primary key makes a collision a hard error rather than a silent
  // overwrite — so retry with a fresh code instead of failing the command.
  let code: string | null = null;
  for (let attempt = 0; attempt < LINK_CODE_INSERT_ATTEMPTS; attempt++) {
    const candidate = generateLinkCode();
    const { error } = await supabase
      .from("link_codes")
      .insert({ code: candidate, device_id: deviceId });

    if (!error) {
      code = candidate;
      break;
    }
    if (error.code !== PG_UNIQUE_VIOLATION) {
      fail(`Failed to create a link code: ${error.message}`);
    }
  }

  if (!code) {
    fail("Could not get an unused link code. Try again in a minute.");
  }

  console.log(`Go to ${VAULT_URL}/link and enter code: ${code}`);

  const deadline = Date.now() + LINK_CODE_TTL_MS;

  while (Date.now() < deadline) {
    await sleep(LINK_POLL_INTERVAL_MS);

    const { data, error } = await supabase
      .from("link_codes")
      .select("claimed_at")
      .eq("code", code)
      .maybeSingle();

    // A transient read failure shouldn't abandon a link the user may have
    // already completed in the browser — keep polling until the code expires.
    if (error) continue;

    // The row is gone: either housekeeping swept it or it was never visible
    // to this device. Either way there's nothing left to claim.
    if (!data) break;

    if (data.claimed_at) {
      console.log("Device linked to your GitHub account.");

      // Best-effort cleanup — the code is spent either way, and the API
      // rejects claimed codes, so a failure here is harmless.
      await supabase.from("link_codes").delete().eq("code", code);
      return;
    }
  }

  console.log("Link code expired. Run cm link again.");
}

// --- cm login ------------------------------------------------------------

const STACKMEM_AUTH_PATH = nodePath.join(nodeOs.homedir(), ".stackmem-auth");
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const LOGIN_POLL_TIMEOUT_MS = 10 * 60 * 1000;

interface GitHubDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface GitHubAccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

// GitHub's OAuth device flow (https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow):
// 1. POST device/code to get a user_code + verification_uri to show the
//    user, and a device_code this process polls with.
// 2. Poll access_token on an interval (GitHub tells us how long) until the
//    user finishes authorizing in the browser, or it expires.
// GITHUB_CLIENT_ID (src/config.ts) is a placeholder — no OAuth App is
// registered yet, so step 1 will fail against the real GitHub API until
// one is. The flow below is complete and real regardless, so wiring in a
// genuine client_id later is a one-line change.
async function cmdLogin(): Promise<void> {
  const deviceCodeRes = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID }),
  });

  if (!deviceCodeRes.ok) {
    fail(`Failed to start GitHub login (${deviceCodeRes.status}): ${await deviceCodeRes.text()}`);
  }

  const deviceCode = (await deviceCodeRes.json()) as GitHubDeviceCodeResponse;
  console.log(`Open ${deviceCode.verification_uri} and enter code: ${deviceCode.user_code}`);

  const deadline = Date.now() + Math.min(deviceCode.expires_in * 1000, LOGIN_POLL_TIMEOUT_MS);
  let pollIntervalMs = Math.max(deviceCode.interval, 5) * 1000;

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);

    const tokenRes = await fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const tokenData = (await tokenRes.json()) as GitHubAccessTokenResponse;

    if (tokenData.access_token) {
      const userRes = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "stackmem-cli" },
      });

      if (!userRes.ok) {
        fail(`Logged in, but failed to fetch GitHub user info (${userRes.status}).`);
      }

      const user = (await userRes.json()) as { login: string };
      nodeFs.writeFileSync(
        STACKMEM_AUTH_PATH,
        JSON.stringify({ github_token: tokenData.access_token, github_user: user.login }, null, 2),
        "utf-8"
      );

      console.log(`Logged in as @${user.login}`);
      return;
    }

    if (tokenData.error === "slow_down") {
      pollIntervalMs += 5000;
      continue;
    }
    if (tokenData.error === "authorization_pending") {
      continue;
    }

    fail(`GitHub login failed: ${tokenData.error_description ?? tokenData.error ?? "unknown error"}`);
  }

  fail("GitHub login timed out after 10 minutes. Run 'cm login' again.");
}

// --- cm open -----------------------------------------------------------

// Separated from cmdOpen so the platform-selection logic is unit-testable
// without actually launching a browser — exercising this for real on
// every platform isn't something a test (or a verification pass) should
// do as a side effect.
export function getOpenCommand(platform: string, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

async function cmdOpen(project: string): Promise<void> {
  const url = `${VAULT_URL}/project/${project}`;
  const { command, args } = getOpenCommand(process.platform, url);

  try {
    execFileSync(command, args, { stdio: "ignore" });
    console.log(`Opened ${url}`);
  } catch (error) {
    fail(
      `Failed to open browser (${error instanceof Error ? error.message : String(error)}). Visit ${url} manually.`
    );
  }
}

// --- cm purge ------------------------------------------------------------

async function cmdPurgeProject(project: string): Promise<void> {
  const { count: total, error: countError } = await supabase
    .from("memories")
    .select("id", { count: "exact", head: true })
    .eq("project", project);
  if (countError) fail(`Failed to count memories: ${countError.message}`);

  console.log(`This will permanently delete all ${total ?? 0} memories for "${project}".`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Type the project name to confirm: ")).trim();
  rl.close();

  if (answer !== project) {
    console.log("Confirmation did not match — aborted. Nothing was deleted.");
    return;
  }

  const { data: memRows, error: memFetchError } = await supabase
    .from("memories")
    .select("id")
    .eq("project", project);
  if (memFetchError) fail(`Failed to load memories: ${memFetchError.message}`);

  const ids = (memRows ?? []).map((m) => m.id);
  let linksDeleted = 0;
  if (ids.length > 0) {
    const idList = ids.join(",");
    const { count, error: linksError } = await supabase
      .from("memory_links")
      .delete({ count: "exact" })
      .or(`source_id.in.(${idList}),target_id.in.(${idList})`);
    if (linksError) fail(`Failed to delete memory links: ${linksError.message}`);
    linksDeleted = count ?? 0;
  }

  const { count: memoriesDeleted, error: memError } = await supabase
    .from("memories")
    .delete({ count: "exact" })
    .eq("project", project);
  if (memError) fail(`Failed to delete memories: ${memError.message}`);

  const { count: fixesDeleted, error: fixError } = await supabase
    .from("execution_log")
    .delete({ count: "exact" })
    .eq("project", project);
  if (fixError) fail(`Failed to delete fixes: ${fixError.message}`);

  console.log(
    `Deleted ${memoriesDeleted ?? 0} memories, ${fixesDeleted ?? 0} fixes, and ${linksDeleted} links for "${project}".`
  );
}

// RLS already scopes every table read/write to this device's device_id
// via the x-device-id header (see src/storage.ts) — a filter-less delete
// here is already confined to this device, never another one. PostgREST
// still requires an explicit filter clause to allow a DELETE at all, so
// `.not("id", "is", null)` (every row has a non-null id) is used purely
// to satisfy that, not to narrow the scope further.
async function cmdPurgeAll(): Promise<void> {
  console.log("This will permanently delete ALL memories across ALL projects for this device.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Type DELETE to confirm: ")).trim();
  rl.close();

  if (answer !== "DELETE") {
    console.log("Confirmation did not match — aborted. Nothing was deleted.");
    return;
  }

  const { count: linksDeleted, error: linksError } = await supabase
    .from("memory_links")
    .delete({ count: "exact" })
    .not("id", "is", null);
  if (linksError) fail(`Failed to delete memory links: ${linksError.message}`);

  const { count: memoriesDeleted, error: memError } = await supabase
    .from("memories")
    .delete({ count: "exact" })
    .not("id", "is", null);
  if (memError) fail(`Failed to delete memories: ${memError.message}`);

  const { count: fixesDeleted, error: fixError } = await supabase
    .from("execution_log")
    .delete({ count: "exact" })
    .not("id", "is", null);
  if (fixError) fail(`Failed to delete fixes: ${fixError.message}`);

  console.log(
    `Deleted ${memoriesDeleted ?? 0} memories, ${fixesDeleted ?? 0} fixes, and ${linksDeleted ?? 0} links across all projects.`
  );
}

// --- cm context ------------------------------------------------------------

const CONTEXT_TYPE_ORDER: MemoryType[] = ["decision", "constraint", "rejection", "discovery"];
const CONTEXT_TOP_N = 5;

// task is null for the PreCompact hook — there's no user-typed task at a
// compaction boundary, just "save the most relevant context" generically
// — so ranking falls back to decay score alone instead of diluting it
// with a relevance score computed against an empty string.
// Mirrors cmdContext's ranking against local-store.ts.
function cmdContextLocal(project: string, task: string | null, hookMode: boolean): void {
  const memories = localListMemories(project);
  if (memories.length === 0) {
    if (!hookMode) console.log(`No memories found for "${project}". (local)`);
    return;
  }

  const config = readStackmemConfig();
  const tokenBudget = config.tokenBudget;

  const scoredMemories = memories
    .map((memory) => {
      const decayScore = computeDecayScore(
        parseUtcDate(memory.created_at),
        memory.access_count ?? 0,
        memory.pinned ?? false,
        config.decayLambda
      );
      const combinedScore =
        task == null ? decayScore : scoreMemoryRelevance(memory.content, task) * 0.6 + decayScore * 0.4;
      return { ...memory, combined_score: combinedScore };
    })
    .sort((a, b) => b.combined_score - a.combined_score);

  const topMemories = scoredMemories.slice(0, CONTEXT_TOP_N);
  const budgetedMemories = applyContextBudget(topMemories, tokenBudget);
  const tokensUsed = budgetedMemories.reduce((sum, memory) => sum + estimateTokens(memory.content), 0);

  const lines: string[] = [`## Project Context: ${project} (local)`];
  if (task != null) lines.push(`### Task: ${task}`);
  lines.push("");

  for (const type of CONTEXT_TYPE_ORDER) {
    const group = budgetedMemories.filter((memory) => memory.type === type);
    if (group.length === 0) continue;

    lines.push(`**${TYPE_LABELS[type]}**`);
    for (const memory of group) {
      lines.push(`- ${memory.content}`);
    }
    lines.push("");
  }

  if (!hookMode) lines.push(`*(${tokensUsed}/${tokenBudget} tokens used)*`);

  console.log(lines.join("\n"));
}

async function cmdContext(project: string, task: string | null, hookMode = false, localMode = false) {
  if (localMode) {
    return cmdContextLocal(project, task, hookMode);
  }

  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .eq("resolved", false)
    .eq("suggested", false);

  if (error) fail(`Failed to load memories: ${error.message}`);

  const memories = data ?? [];
  if (memories.length === 0) {
    if (!hookMode) console.log(`No memories found for "${project}".`);
    return;
  }

  const config = readStackmemConfig();
  const tokenBudget = config.tokenBudget;

  const scoredMemories = memories
    .map((memory) => {
      const decayScore = computeDecayScore(
        parseUtcDate(memory.created_at),
        memory.access_count ?? 0,
        memory.pinned ?? false,
        config.decayLambda
      );
      const combinedScore =
        task == null ? decayScore : scoreMemoryRelevance(memory.content, task) * 0.6 + decayScore * 0.4;
      return { ...memory, combined_score: combinedScore };
    })
    .sort((a, b) => b.combined_score - a.combined_score);

  const topMemories = scoredMemories.slice(0, CONTEXT_TOP_N);
  const budgetedMemories = applyContextBudget(topMemories, tokenBudget);
  const tokensUsed = budgetedMemories.reduce(
    (sum, memory) => sum + estimateTokens(memory.content),
    0
  );

  const lines: string[] = [`## Project Context: ${project}`];
  if (task != null) lines.push(`### Task: ${task}`);
  lines.push("");

  for (const type of CONTEXT_TYPE_ORDER) {
    const group = budgetedMemories.filter((memory) => memory.type === type);
    if (group.length === 0) continue;

    lines.push(`**${TYPE_LABELS[type]}**`);
    for (const memory of group) {
      lines.push(`- ${memory.content}`);
    }
    lines.push("");
  }

  if (!hookMode) lines.push(`*(${tokensUsed}/${tokenBudget} tokens used)*`);

  console.log(lines.join("\n"));
}

// --- cm why --------------------------------------------------------------

function fileMatchesPaths(filePaths: unknown, file: string, baseName: string): boolean {
  if (!Array.isArray(filePaths)) return false;
  return filePaths.some((p) => typeof p === "string" && (p === file || p.split("/").pop() === baseName));
}

function fileMentionedInContent(content: string, file: string, baseName: string): boolean {
  const lower = content.toLowerCase();
  return lower.includes(file.toLowerCase()) || lower.includes(baseName.toLowerCase());
}

async function cmdWhy(project: string, file: string) {
  const baseName = file.split("/").pop() ?? file;

  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .eq("resolved", false)
    .eq("suggested", false);

  if (error) fail(`Failed to load memories: ${error.message}`);

  const memories = data ?? [];

  // file_paths (structured, from Item 6) and a content substring search
  // are combined into one match set rather than one gating the other as
  // a strict fallback — most memories predate file_paths existing at all
  // (manual saves and seeds never set it), so content search is the
  // primary signal for everything except recent hook-captured commits,
  // not a rare last resort.
  const matched = memories.filter(
    (memory) =>
      fileMatchesPaths(memory.file_paths, file, baseName) ||
      fileMentionedInContent(memory.content, file, baseName)
  );

  if (matched.length === 0) {
    console.log(`No memories found for ${file}.`);
    console.log("Make some commits touching this file to build up context.");
    return;
  }

  const config = readStackmemConfig();
  const scoredMemories = matched
    .map((memory) => ({
      ...memory,
      decay_score: computeDecayScore(
        parseUtcDate(memory.created_at),
        memory.access_count ?? 0,
        memory.pinned ?? false,
        config.decayLambda
      ),
    }))
    .sort((a, b) => b.decay_score - a.decay_score);

  console.log(`Decisions and constraints tied to ${file}:\n`);

  for (const type of MEMORY_TYPES) {
    const group = scoredMemories.filter((memory) => memory.type === type);
    if (group.length === 0) continue;

    console.log(`${TYPE_LABELS[type]} (${group.length})`);
    console.log("-".repeat(TYPE_LABELS[type].length + 4));
    for (const memory of group) {
      console.log(`  [${memory.id}] (score: ${memory.decay_score.toFixed(2)}) ${memory.content}`);
    }
    console.log("");
  }
}

// --- cm session-end --------------------------------------------------------

interface SessionEndInput {
  project: string | null;
  summary?: string;
  errors: string[];
  files: string[];
  approaches: string[];
}

function splitCommaList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Flags only — stdin JSON is handled separately in cmdSessionEndEntry, since
// it carries its own full shape (arrays, not comma-joined strings).
function parseSessionEndFlags(args: string[]): SessionEndInput {
  let project: string | null = null;
  let summary: string | undefined;
  let errors: string[] = [];
  let files: string[] = [];
  let approaches: string[] = [];

  let i = 0;
  if (args[i] && !args[i].startsWith("--")) {
    project = args[i];
    i++;
  }

  for (; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--summary") {
      summary = value;
      i++;
    } else if (flag === "--errors") {
      errors = splitCommaList(value);
      i++;
    } else if (flag === "--files") {
      files = splitCommaList(value);
      i++;
    } else if (flag === "--approaches") {
      approaches = splitCommaList(value);
      i++;
    } else if (flag === "--hook") {
      // Recognized explicitly (not just silently skipped as an unknown
      // flag) — see the comment on cmdSessionEnd for why it's currently
      // a no-op here specifically.
    }
  }

  return { project, summary, errors, files, approaches };
}

async function readStdinJson(): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

// --hook is accepted (see parseSessionEndFlags) but currently a no-op:
// Claude Code's Stop hook pipes ITS OWN JSON payload on stdin (session
// id, transcript path, cwd — see the Claude Code hooks docs), not the
// {summary, errors_encountered, files_touched, approaches_tried} shape
// this command expects. readStdinJson() parses that payload successfully
// (it's valid JSON) but finds none of the fields it looks for, so every
// array below comes back empty and this reports 0 memories saved — a
// real, known limitation, not a bug. Extracting genuine learnings from
// the Stop hook would mean parsing the session transcript itself, which
// is out of scope here (Phase 2, per the user).
async function cmdSessionEnd(project: string, input: Omit<SessionEndInput, "project">) {
  let memoriesSaved = 0;
  let errorsLogged = 0;

  for (const problem of input.errors) {
    const { error } = await supabase.from("execution_log").insert({
      project,
      problem,
      solution: null,
      resolved: false,
      device_id: getDeviceId(),
    });
    if (!error) errorsLogged++;
  }

  for (const approach of input.approaches) {
    if (!indicatesFailedApproach(approach)) continue;
    const { error } = await supabase.from("memories").insert({
      project,
      type: "rejection",
      content: approach,
      device_id: getDeviceId(),
    });
    if (!error) memoriesSaved++;
  }

  if (input.summary && isQualityMessage(input.summary)) {
    const { error } = await supabase.from("memories").insert({
      project,
      type: "decision",
      content: input.summary.trim(),
      device_id: getDeviceId(),
    });
    if (!error) memoriesSaved++;
  }

  const authFiles = input.files.filter(isAuthRelatedFile);
  if (authFiles.length > 0) {
    const { error } = await supabase.from("memories").insert({
      project,
      type: "discovery",
      content: `session touched auth files: ${authFiles.join(", ")}`,
      device_id: getDeviceId(),
    });
    if (!error) memoriesSaved++;
  }

  if (input.files.some(isCodeFile)) {
    analyzeCodebase(process.cwd());
  }

  console.log(`Session captured. ${memoriesSaved} memories saved.`);
  if (errorsLogged > 0) {
    console.log(`${errorsLogged} error(s) logged to execution_log.`);
  }
}

// Dispatches to JSON-from-stdin or flag parsing depending on how the
// command was invoked — piped input (e.g. from a script) uses JSON; an
// interactive terminal with no piped stdin uses flags.
async function cmdSessionEndEntry(args: string[]) {
  let input: SessionEndInput;

  if (!process.stdin.isTTY) {
    const json = await readStdinJson();
    if (json) {
      input = {
        project: typeof json.project === "string" ? json.project : null,
        summary: typeof json.summary === "string" ? json.summary : undefined,
        errors: Array.isArray(json.errors_encountered) ? json.errors_encountered : [],
        files: Array.isArray(json.files_touched) ? json.files_touched : [],
        approaches: Array.isArray(json.approaches_tried) ? json.approaches_tried : [],
      };
    } else {
      input = parseSessionEndFlags(args);
    }
  } else {
    input = parseSessionEndFlags(args);
  }

  const project = requireProject(input.project);
  await cmdSessionEnd(project, {
    summary: input.summary,
    errors: input.errors,
    files: input.files,
    approaches: input.approaches,
  });
}

// --- cm doctor ---------------------------------------------------------

// Re-reads the freshly (re)written config to confirm the MCP entry is
// actually there now, rather than trusting registerMcpServer didn't throw.
function isMcpRegistered(claudeConfigPath: string): boolean {
  if (!nodeFs.existsSync(claudeConfigPath)) return false;
  try {
    const config = JSON.parse(nodeFs.readFileSync(claudeConfigPath, "utf-8"));
    return Boolean(config?.mcpServers?.stackmem);
  } catch {
    return false;
  }
}

function isHookExecutable(hookPath: string): boolean {
  if (!nodeFs.existsSync(hookPath)) return false;
  try {
    nodeFs.accessSync(hookPath, nodeFs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// --- cm status ---------------------------------------------------------

function hasMcpServersStackmemKey(configPath: string): boolean {
  if (!nodeFs.existsSync(configPath)) return false;
  try {
    const config = JSON.parse(nodeFs.readFileSync(configPath, "utf-8"));
    return Boolean(config?.mcpServers?.stackmem);
  } catch {
    return false;
  }
}

function hasContextServersStackmemKey(configPath: string): boolean {
  if (!nodeFs.existsSync(configPath)) return false;
  try {
    const config = JSON.parse(nodeFs.readFileSync(configPath, "utf-8"));
    return Boolean(config?.context_servers?.stackmem);
  } catch {
    return false;
  }
}

const EDITOR_STATUS_CHECKS: { name: string; isRegistered: (homeDir: string) => boolean }[] = [
  { name: "Claude Code", isRegistered: (homeDir) => isMcpRegistered(nodePath.join(homeDir, ".claude.json")) },
  { name: "Cursor", isRegistered: (homeDir) => hasMcpServersStackmemKey(nodePath.join(homeDir, ".cursor", "mcp.json")) },
  {
    name: "Windsurf",
    isRegistered: (homeDir) =>
      hasMcpServersStackmemKey(nodePath.join(homeDir, ".codeium", "windsurf", "mcp_config.json")),
  },
  {
    name: "VS Code",
    isRegistered: (homeDir) => {
      const dir = findCopilotChatExtensionDir(homeDir);
      return dir ? hasMcpServersStackmemKey(nodePath.join(dir, "mcp.json")) : false;
    },
  },
  {
    name: "Zed",
    isRegistered: (homeDir) => hasContextServersStackmemKey(nodePath.join(homeDir, ".config", "zed", "settings.json")),
  },
];

async function cmdStatus(project: string): Promise<void> {
  const { count: totalCount, error: totalError } = await supabase
    .from("memories")
    .select("id", { count: "exact", head: true })
    .eq("project", project)
    .eq("resolved", false);
  if (totalError) fail(`Failed to load memory count: ${totalError.message}`);

  const { count: pinnedCount, error: pinnedError } = await supabase
    .from("memories")
    .select("id", { count: "exact", head: true })
    .eq("project", project)
    .eq("resolved", false)
    .eq("pinned", true);
  if (pinnedError) fail(`Failed to load pinned count: ${pinnedError.message}`);

  const { count: suggestedCount, error: suggestedError } = await supabase
    .from("memories")
    .select("id", { count: "exact", head: true })
    .eq("project", project)
    .eq("resolved", false)
    .eq("suggested", true);
  if (suggestedError) fail(`Failed to load suggested count: ${suggestedError.message}`);

  const { count: fixesCount, error: fixesError } = await supabase
    .from("execution_log")
    .select("id", { count: "exact", head: true })
    .eq("project", project)
    .eq("resolved", false);
  if (fixesError) fail(`Failed to load fixes count: ${fixesError.message}`);

  const { data: lastCaptureRows, error: lastCaptureError } = await supabase
    .from("memories")
    .select("content, created_at")
    .eq("project", project)
    .order("created_at", { ascending: false })
    .limit(1);
  if (lastCaptureError) fail(`Failed to load last capture: ${lastCaptureError.message}`);

  const config = readStackmemConfig();
  const configPath = nodePath.join(process.cwd(), STACKMEM_CONFIG_FILENAME);
  let usesCustomBudget = false;
  if (nodeFs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(nodeFs.readFileSync(configPath, "utf-8"));
      usesCustomBudget = typeof raw.tokenBudget === "number";
    } catch {
      // Malformed config — readStackmemConfig already falls back to the
      // default in this case too, so "default" is the accurate label.
    }
  }

  const hookOk = isHookExecutable(nodePath.join(process.cwd(), ".git", "hooks", "post-commit"));
  const mcpOk = isMcpRegistered(getClaudeConfigPath());
  const backendOk = await verifyBackendConnection(project);

  const homeDir = nodeOs.homedir();
  const registeredEditors = EDITOR_STATUS_CHECKS.filter((e) => e.isRegistered(homeDir)).map((e) => e.name);

  console.log(`stackmem status for "${project}"`);
  console.log("━".repeat(27));
  console.log(
    `Memories:     ${totalCount ?? 0} total (${pinnedCount ?? 0} pinned, ${suggestedCount ?? 0} suggested)`
  );
  console.log(`Fixes:        ${fixesCount ?? 0} recorded`);
  console.log(`Token budget: ${config.tokenBudget} (${usesCustomBudget ? "from .stackmem.json" : "default"})`);

  const lastCapture = (lastCaptureRows ?? [])[0];
  if (lastCapture) {
    const ago = formatRelativeTime(parseUtcDate(lastCapture.created_at));
    const snippet =
      lastCapture.content.length > 50 ? `${lastCapture.content.slice(0, 50)}…` : lastCapture.content;
    console.log(`Last capture: ${ago} (${snippet})`);
  } else {
    console.log("Last capture: none yet");
  }

  console.log(`Hook:         ${hookOk ? "✓ installed" : "✗ not installed"}`);
  console.log(`MCP:          ${mcpOk ? "✓ registered" : "✗ not registered"}`);
  console.log(`Backend:      ${backendOk ? "✓ connected" : "✗ not connected"}`);
  console.log(
    `Editors:      ${
      registeredEditors.length > 0 ? registeredEditors.map((name) => `${name} ✓`).join("  ") : "(none registered)"
    }`
  );
}

async function cmdDoctor(fix: boolean) {
  let issues = 0;
  const project = readProjectFromFile();

  // 1. Backend connection
  const backendOk = await verifyBackendConnection(project ?? "");
  if (backendOk) {
    console.log("✓ Backend connection verified");
  } else {
    console.log("✗ Backend connection failed — check your network");
    issues++;
    if (fix) {
      console.log(
        "Could not auto-fix: backend connection — check your network and Supabase status, then re-run 'cm doctor'."
      );
    }
  }

  // 2. MCP server registration
  const claudeConfigPath = getClaudeConfigPath();
  const mcpRegistered = isMcpRegistered(claudeConfigPath);
  if (mcpRegistered) {
    console.log("✓ MCP server registered with Claude Code");
  } else {
    console.log("✗ MCP server not registered — run 'cm init <project> .'");
    issues++;
    if (fix) {
      registerMcpServer(DIST_INDEX_PATH, claudeConfigPath);
      if (isMcpRegistered(claudeConfigPath)) {
        console.log("Fixed: MCP server registration");
        issues--;
      } else {
        console.log("Could not auto-fix: MCP server registration");
      }
    }
  }

  // 3. Project file
  if (project) {
    console.log(`✓ Project file found: ${project}`);
  } else {
    console.log("✗ No .stackmem found — run 'cm init <project> .'");
    issues++;
    if (fix) {
      console.log("Could not auto-fix: .stackmem file — run 'cm init <project> .'");
    }
  }

  // 4. Git hook
  const gitDir = nodePath.join(process.cwd(), ".git");
  if (!nodeFs.existsSync(gitDir)) {
    console.log("✗ No git repo found in current directory");
    issues++;
  } else {
    const hooksDir = nodePath.join(gitDir, "hooks");
    const hookPath = nodePath.join(hooksDir, "post-commit");

    if (isHookExecutable(hookPath)) {
      console.log("✓ Git hook installed");
    } else {
      console.log("✗ Git hook not installed — run 'cm init <project> .'");
      issues++;
      if (fix) {
        const codingMemoryDir = nodePath.join(process.cwd(), ".coding-memory");
        nodeFs.mkdirSync(codingMemoryDir, { recursive: true });
        const hookLogicPath = nodePath.join(codingMemoryDir, "post-commit-hook.mjs");
        nodeFs.writeFileSync(hookLogicPath, buildHookLogicScript(DIST_CLI_PATH), "utf-8");
        for (const name of MANAGED_HOOK_NAMES) {
          installHook(hooksDir, hookLogicPath, name);
        }

        if (isHookExecutable(hookPath)) {
          console.log("Fixed: git hook");
          issues--;
        } else {
          console.log("Could not auto-fix: git hook");
        }
      }
    }
  }

  // 5. Memory count
  let hasMemories = false;
  if (project) {
    const { count, error } = await supabase
      .from("memories")
      .select("id", { count: "exact", head: true })
      .eq("project", project)
      .eq("resolved", false);

    hasMemories = !error && (count ?? 0) > 0;
    if (hasMemories) {
      console.log(`✓ ${count} memories stored for "${project}"`);
    }
  }
  if (!hasMemories) {
    console.log(`✗ No memories yet — make a commit to start capturing`);
    issues++;
    if (fix) {
      console.log("Could not auto-fix: memories — make a commit to start capturing");
    }
  }

  if (process.platform === "win32") {
    console.log("");
    console.log(
      "Note: on Windows, the git hook is installed as a native .cmd wrapper rather than a #!/bin/sh script. If a pre-existing hook was chained and it isn't itself a .cmd/.bat/.ps1 script, it may not run correctly through the wrapper — check .git/hooks/post-commit if automated captures seem to be missing."
    );
  }

  console.log("");
  if (issues === 0) {
    console.log("All systems operational.");
  } else {
    console.log(`${issues} issue(s) found. See above.`);
  }
}

// --- cm undo -------------------------------------------------------------

async function cmdUndo(project: string) {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .eq("resolved", false)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) fail(`Failed to load most recent memory: ${error.message}`);

  const memory = (data ?? [])[0];
  if (!memory) {
    console.log("Nothing to undo.");
    return;
  }

  const { error: linksError } = await supabase
    .from("memory_links")
    .delete()
    .or(`source_id.eq.${memory.id},target_id.eq.${memory.id}`);

  if (linksError) fail(`Failed to delete memory links: ${linksError.message}`);

  const { error: deleteError } = await supabase.from("memories").delete().eq("id", memory.id);

  if (deleteError) fail(`Failed to delete memory: ${deleteError.message}`);

  console.log(`Undone: [${memory.type}] ${memory.content}`);
}

// --- cm export -------------------------------------------------------------

async function cmdExport(project: string, filename?: string) {
  const { data: memories, error: memoriesError } = await supabase
    .from("memories")
    .select("*")
    .eq("project", project)
    .eq("resolved", false);

  if (memoriesError) fail(`Failed to load memories: ${memoriesError.message}`);

  const { data: executionLog, error: executionLogError } = await supabase
    .from("execution_log")
    .select("*")
    .eq("project", project);

  if (executionLogError) fail(`Failed to load execution log: ${executionLogError.message}`);

  const memoryResults = memories ?? [];
  const memoryIds = memoryResults.map((m) => m.id);

  let memoryLinks: unknown[] = [];
  if (memoryIds.length > 0) {
    const idList = memoryIds.join(",");
    const { data: links, error: linksError } = await supabase
      .from("memory_links")
      .select("*")
      .or(`source_id.in.(${idList}),target_id.in.(${idList})`);

    if (linksError) fail(`Failed to load memory links: ${linksError.message}`);
    memoryLinks = links ?? [];
  }

  const exportData = {
    project,
    exported_at: new Date().toISOString(),
    memories: memoryResults,
    execution_log: executionLog ?? [],
    memory_links: memoryLinks,
  };

  const outputFilename = filename ?? `${project}-memories.json`;
  nodeFs.writeFileSync(outputFilename, JSON.stringify(exportData, null, 2), "utf-8");

  console.log(`Exported ${memoryResults.length} memories to ${outputFilename}`);
}

// --- cm import -------------------------------------------------------------

async function cmdImport(project: string, filename: string) {
  if (!nodeFs.existsSync(filename)) {
    console.log(`File not found: ${filename}`);
    return;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(nodeFs.readFileSync(filename, "utf-8"));
  } catch (error) {
    fail(`Failed to parse ${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const memories = Array.isArray(parsed.memories) ? parsed.memories : [];
  const executionLogEntries = Array.isArray(parsed.execution_log) ? parsed.execution_log : [];

  // memory_links are intentionally skipped — they get rebuilt by semantic
  // linking the next time cm save runs against the imported memories.

  let importedCount = 0;
  for (const memory of memories) {
    const { error } = await supabase.from("memories").insert({
      project,
      type: memory.type,
      content: memory.content,
      device_id: getDeviceId(),
    });
    if (!error) importedCount++;
  }

  for (const entry of executionLogEntries) {
    await supabase.from("execution_log").insert({
      project,
      problem: entry.problem,
      solution: entry.solution ?? null,
      resolved: entry.resolved ?? false,
      device_id: getDeviceId(),
    });
  }

  console.log(`Imported ${importedCount} memories from ${filename}`);
}

// --- cm uninstall ------------------------------------------------------

function readProjectFromPath(dirPath: string): string | null {
  const stackmemPath = nodePath.join(dirPath, STACKMEM_FILE);
  if (!nodeFs.existsSync(stackmemPath)) return null;
  const content = nodeFs.readFileSync(stackmemPath, "utf-8").trim();
  return content.length > 0 ? content : null;
}

// Removes a marker-gated file (CLAUDE.md / .cursorrules / .windsurfrules)
// only if it still carries the stackmem marker — a file the user has since
// rewritten by hand, or never had stackmem's content to begin with, is left
// alone rather than silently deleted.
function removeIfMarked(filePath: string, marker: string, label: string): void {
  if (!nodeFs.existsSync(filePath)) return;

  const content = nodeFs.readFileSync(filePath, "utf-8");
  if (!content.includes(marker)) {
    console.log(`Skipped ${label} (no stackmem marker found — left as-is).`);
    return;
  }

  nodeFs.unlinkSync(filePath);
  console.log(`Removed ${label}`);
}

async function cmdUninstall(project: string, targetPath: string) {
  const gitDir = nodePath.join(targetPath, ".git");
  const hooksDir = nodePath.join(gitDir, "hooks");

  for (const hookName of MANAGED_HOOK_NAMES) {
    const hookResult = uninstallHook(hooksDir, hookName);
    if (hookResult) console.log(`Removed ${hookResult}`);
  }

  const codingMemoryDir = nodePath.join(targetPath, ".coding-memory");

  const hookLogicPath = nodePath.join(codingMemoryDir, "post-commit-hook.mjs");
  if (nodeFs.existsSync(hookLogicPath)) {
    nodeFs.unlinkSync(hookLogicPath);
    console.log("Removed .coding-memory/post-commit-hook.mjs");
  }

  const astDbPath = nodePath.join(codingMemoryDir, "ast-index.db");
  if (nodeFs.existsSync(astDbPath)) {
    nodeFs.unlinkSync(astDbPath);
    console.log("Removed .coding-memory/ast-index.db");
  }

  if (nodeFs.existsSync(codingMemoryDir) && nodeFs.readdirSync(codingMemoryDir).length === 0) {
    nodeFs.rmdirSync(codingMemoryDir);
    console.log("Removed .coding-memory/ directory");
  }

  const stackmemPath = nodePath.join(targetPath, STACKMEM_FILE);
  if (nodeFs.existsSync(stackmemPath)) {
    nodeFs.unlinkSync(stackmemPath);
    console.log("Removed .stackmem");
  }

  removeIfMarked(nodePath.join(targetPath, "CLAUDE.md"), CLAUDE_MD_MARKER, "CLAUDE.md");
  removeIfMarked(nodePath.join(targetPath, ".cursorrules"), RULES_FILE_MARKER, ".cursorrules");
  removeIfMarked(nodePath.join(targetPath, ".windsurfrules"), RULES_FILE_MARKER, ".windsurfrules");

  if (unregisterMcpServer()) {
    console.log("Removed stackmem entry from ~/.claude.json mcpServers");
  }

  console.log(`stackmem uninstalled from ${project}.`);
}

// --- main --------------------------------------------------------------

async function main() {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "start": {
      const { localMode, rest: withoutLocal } = extractLocalFlag(args);
      const hookIndex = withoutLocal.indexOf("--hook");
      const hookMode = hookIndex !== -1;
      const positional = hookMode
        ? [...withoutLocal.slice(0, hookIndex), ...withoutLocal.slice(hookIndex + 1)]
        : withoutLocal;

      const split = splitOptionalProject(positional, 0);
      if (!split) usage();
      const project = requireProject(split.project);
      await cmdStart(project, hookMode, localMode);
      break;
    }
    case "save": {
      const { localMode, rest: withoutLocal } = extractLocalFlag(args);
      const forceIndex = withoutLocal.indexOf("--force");
      const force = forceIndex !== -1;
      let positional = force
        ? [...withoutLocal.slice(0, forceIndex), ...withoutLocal.slice(forceIndex + 1)]
        : withoutLocal;

      const commitShaFlag = extractValueFlag(positional, "--commit-sha");
      positional = commitShaFlag.rest;
      const authorFlag = extractValueFlag(positional, "--author");
      positional = authorFlag.rest;
      const sourceFlag = extractValueFlag(positional, "--source");
      positional = sourceFlag.rest;
      const confidenceFlag = extractValueFlag(positional, "--confidence");
      positional = confidenceFlag.rest;
      const filesFlag = extractValueFlag(positional, "--files");
      positional = filesFlag.rest;

      let explicitProject: string | null;
      let type: string | undefined;
      let rest: string[];
      // Exactly two positional args can only mean <type> <content> with the
      // project omitted — an explicit project would need a third slot for
      // content, which wouldn't exist. Without this check, a typo'd type
      // (failing the MEMORY_TYPES.includes test below) used to fall into
      // the "explicit project" branch instead, shifting content out of
      // existence and surfacing a generic usage() dump instead of the
      // targeted invalid-type error.
      if (positional.length === 2 || MEMORY_TYPES.includes(positional[0] as MemoryType)) {
        explicitProject = null;
        [type, ...rest] = positional;
      } else {
        explicitProject = positional[0] ?? null;
        [, type, ...rest] = positional;
      }

      if (type !== undefined && !MEMORY_TYPES.includes(type as MemoryType)) {
        fail(`Invalid memory type '${type}'. Valid types: decision, constraint, discovery, rejection.`);
      }

      if (!type || rest.length === 0) usage();
      const project = requireProject(explicitProject);

      const provenance: SaveProvenance = {};
      if (commitShaFlag.value) provenance.commitSha = commitShaFlag.value;
      if (authorFlag.value) provenance.author = authorFlag.value;
      if (sourceFlag.value === "hook" || sourceFlag.value === "manual" || sourceFlag.value === "mcp") {
        provenance.source = sourceFlag.value;
      }
      if (confidenceFlag.value) {
        const parsed = Number(confidenceFlag.value);
        if (!Number.isNaN(parsed)) provenance.confidence = parsed;
      }
      if (filesFlag.value) {
        provenance.filePaths = filesFlag.value.split(",").map((f) => f.trim()).filter(Boolean);
      }

      await cmdSave(project, type, rest.join(" "), force, provenance, localMode);
      break;
    }
    case "check-commit": {
      const [project, commitSha] = args;
      if (!project || !commitSha) usage();
      await cmdCheckCommit(project, commitSha);
      break;
    }
    case "fix": {
      const { localMode, rest: withoutLocal } = extractLocalFlag(args);
      const split = splitOptionalProject(withoutLocal, 2);
      if (!split) usage();
      const project = requireProject(split.project);
      const [problem, solution] = split.rest;
      await cmdFix(project, problem, solution, localMode);
      break;
    }
    case "analyze": {
      const split = splitOptionalProject(args, 1);
      if (!split) usage();
      const project = requireProject(split.project);
      const [path] = split.rest;
      await cmdAnalyze(project, path);
      break;
    }
    case "search": {
      const { localMode, rest: withoutLocal } = extractLocalFlag(args);
      const split = splitProjectFromVariadic(withoutLocal);
      const project = requireProject(split.project);
      if (split.rest.length === 0) usage();
      await cmdSearch(project, split.rest.join(" "), localMode);
      break;
    }
    case "resolve": {
      const split = splitOptionalProject(args, 1);
      if (!split) usage();
      const project = requireProject(split.project);
      const [memoryId] = split.rest;
      await cmdResolve(project, memoryId);
      break;
    }
    case "pin": {
      const split = splitOptionalProject(args, 1);
      if (!split) usage();
      const project = requireProject(split.project);
      const [memoryId] = split.rest;
      await cmdPin(project, memoryId);
      break;
    }
    case "unpin": {
      const split = splitOptionalProject(args, 1);
      if (!split) usage();
      const project = requireProject(split.project);
      const [memoryId] = split.rest;
      await cmdUnpin(project, memoryId);
      break;
    }
    case "review": {
      const split = splitProjectFromVariadic(args);
      if (split.rest.length > 0) usage();
      const project = requireProject(split.project);
      await cmdReview(project);
      break;
    }
    case "edit": {
      const split = splitOptionalProject(args, 1);
      if (!split) usage();
      const project = requireProject(split.project);
      const [memoryId] = split.rest;
      await cmdEdit(project, memoryId);
      break;
    }
    case "delete": {
      const split = splitOptionalProject(args, 1);
      if (!split) usage();
      const project = requireProject(split.project);
      const [memoryId] = split.rest;
      await cmdDelete(project, memoryId);
      break;
    }
    case "inspect": {
      const split = splitOptionalProject(args, 1);
      if (!split) usage();
      const project = requireProject(split.project);
      const [memoryId] = split.rest;
      await cmdInspect(project, memoryId);
      break;
    }
    case "compress": {
      const split = splitOptionalProject(args, 0);
      if (!split) usage();
      const project = requireProject(split.project);
      await cmdCompress(project);
      break;
    }
    case "init": {
      const wizardIndex = args.indexOf("--wizard");
      if (wizardIndex !== -1) {
        const wizardPositional = [...args.slice(0, wizardIndex), ...args.slice(wizardIndex + 1)];
        await cmdInitWizard(wizardPositional[0] ?? ".");
        break;
      }

      const configIndex = args.indexOf("--config");
      const writeConfig = configIndex !== -1;
      const positional = writeConfig
        ? [...args.slice(0, configIndex), ...args.slice(configIndex + 1)]
        : args;

      const [project, targetPath] = positional;
      if (!project || !targetPath) usage();
      await cmdInit(project, targetPath, writeConfig);
      break;
    }
    case "link": {
      if (args.length > 0) usage();
      await cmdLink();
      break;
    }
    case "login": {
      if (args.length > 0) usage();
      await cmdLogin();
      break;
    }
    case "open": {
      const split = splitProjectFromVariadic(args);
      if (split.rest.length > 0) usage();
      const project = requireProject(split.project);
      await cmdOpen(project);
      break;
    }
    case "purge": {
      const allIndex = args.indexOf("--all");
      const isAll = allIndex !== -1;
      const withoutAllFlag = isAll ? [...args.slice(0, allIndex), ...args.slice(allIndex + 1)] : args;

      const split = splitProjectFromVariadic(withoutAllFlag);
      if (split.rest.length > 0) usage();

      if (isAll) {
        await cmdPurgeAll();
      } else {
        const project = requireProject(split.project);
        await cmdPurgeProject(project);
      }
      break;
    }
    case "sync": {
      if (args.length > 0) usage();
      const project = requireProject(null);
      await cmdSync(project);
      break;
    }
    case "context": {
      const { localMode, rest: withoutLocal } = extractLocalFlag(args);
      const hookIndex = withoutLocal.indexOf("--hook");
      const hookMode = hookIndex !== -1;
      const withoutHookFlag = hookMode
        ? [...withoutLocal.slice(0, hookIndex), ...withoutLocal.slice(hookIndex + 1)]
        : withoutLocal;

      const split = splitProjectFromVariadic(withoutHookFlag);
      const project = requireProject(split.project);
      // task is optional only in --hook mode (the PreCompact hook has no
      // user-typed task to pass) — interactive use still requires one.
      if (split.rest.length === 0 && !hookMode) usage();
      const task = split.rest.length > 0 ? split.rest.join(" ") : null;
      await cmdContext(project, task, hookMode, localMode);
      break;
    }
    case "why": {
      const split = splitProjectFromVariadic(args);
      const project = requireProject(split.project);
      if (split.rest.length === 0) usage();
      await cmdWhy(project, split.rest.join(" "));
      break;
    }
    case "session-end": {
      await cmdSessionEndEntry(args);
      break;
    }
    case "doctor": {
      const fix = args.includes("--fix");
      await cmdDoctor(fix);
      break;
    }
    case "status": {
      const split = splitProjectFromVariadic(args);
      if (split.rest.length > 0) usage();
      const project = requireProject(split.project);
      await cmdStatus(project);
      break;
    }
    case "undo": {
      const split = splitOptionalProject(args, 0);
      if (!split) usage();
      const project = requireProject(split.project);
      await cmdUndo(project);
      break;
    }
    case "export": {
      if (args.length > 1) usage();
      const [filename] = args;
      const project = requireProject(null);
      await cmdExport(project, filename);
      break;
    }
    case "import": {
      const split = splitOptionalProject(args, 1);
      if (!split) usage();
      const project = requireProject(split.project);
      const [filename] = split.rest;
      await cmdImport(project, filename);
      break;
    }
    case "uninstall": {
      if (args.length > 2) usage();

      let explicitProject: string | null = null;
      let targetPath = process.cwd();
      if (args.length === 1) {
        if (looksLikeAPath(args[0])) {
          targetPath = args[0];
        } else {
          explicitProject = args[0];
        }
      } else if (args.length === 2) {
        [explicitProject, targetPath] = args;
      }

      const resolvedPath = nodePath.resolve(targetPath);
      const project = explicitProject ?? readProjectFromPath(resolvedPath);
      if (!project) {
        console.error(`No project specified and no .stackmem file found at ${resolvedPath}.`);
        process.exit(1);
      }

      await cmdUninstall(project, resolvedPath);
      break;
    }
    case "telemetry": {
      if (args.includes("--enable")) {
        enableTelemetry();
        console.log("Telemetry enabled. Anonymous usage stats will be sent (no code, no memories).");
      } else if (args.includes("--disable")) {
        disableTelemetry();
        console.log("Telemetry disabled.");
      } else {
        console.log(`Telemetry is currently ${isTelemetryEnabled() ? "enabled" : "disabled"}.`);
        console.log("Use --enable or --disable to change it.");
      }
      break;
    }
    case "help": {
      cmdHelp();
      break;
    }
    default:
      usage();
  }
}

// Guards the auto-run so importing this module (e.g. from a test file, to
// reach exported helpers like trySeedMemory) doesn't also execute main()
// against the test runner's own argv. realpathSync matters here: the `cm`
// bin is typically a symlink (npm link, or the global install this project
// itself uses), and process.argv[1] preserves the symlink path as invoked
// while import.meta.url resolves to the link's real target — comparing
// them raw would never match, silently skipping main() entirely.
function resolveMainModulePath(argvPath: string): string | null {
  try {
    return pathToFileURL(nodeFs.realpathSync(argvPath)).href;
  } catch {
    return null;
  }
}

const isMainModule =
  process.argv[1] != null && import.meta.url === resolveMainModulePath(process.argv[1]);
if (isMainModule) {
  process.on("uncaughtException", (error) => {
    void reportError(error).finally(() => {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
  });
  process.on("unhandledRejection", (reason) => {
    void reportError(reason).finally(() => {
      console.error(`Error: ${reason instanceof Error ? reason.message : String(reason)}`);
      process.exit(1);
    });
  });

  main().catch(async (error) => {
    await reportError(error);
    fail(error instanceof Error ? error.message : String(error));
  });
}
