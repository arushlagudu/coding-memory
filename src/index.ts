#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { analyzeCodebase, getFileSummary, findDependencies } from "./ast-index.js";
import { computeDecayScore, computeMemoryLinks, decideSaveAction } from "./scoring.js";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable (check .env)."
  );
}

// createClient wants the project base URL; strip a REST path if one was configured in .env.
const supabaseBaseUrl = SUPABASE_URL.replace(/\/rest\/v1\/?$/, "");
// Service-role key bypasses RLS — this server only runs locally/stdio-side, never exposed to a client.
const supabase = createClient(supabaseBaseUrl, SUPABASE_SERVICE_ROLE_KEY);

const server = new McpServer({
  name: "coding-memory",
  version: "1.0.0",
});

// --- session_start -----------------------------------------------------

server.registerTool(
  "session_start",
  {
    title: "Session Start",
    description: "Signal the start of a coding session for a given project.",
    inputSchema: {
      project: z.string().describe("Project identifier"),
    },
  },
  async ({ project }) => {
    const { data, error } = await supabase
      .from("memories")
      .select("*")
      .eq("project", project)
      .eq("resolved", false);

    if (error) {
      throw new Error(`Failed to load memories: ${error.message}`);
    }

    const memories = data ?? [];

    const scoredMemories = memories
      .map((memory) => ({
        ...memory,
        decay_score: computeDecayScore(new Date(memory.created_at), memory.access_count ?? 0),
      }))
      .sort((a, b) => b.decay_score - a.decay_score);

    const memoryIds = scoredMemories.map((m) => m.id);
    const linkedIdsByMemory = new Map<string, Set<string>>();

    if (memoryIds.length > 0) {
      const idList = memoryIds.join(",");
      const { data: links, error: linksError } = await supabase
        .from("memory_links")
        .select("source_id, target_id")
        .or(`source_id.in.(${idList}),target_id.in.(${idList})`);

      if (linksError) {
        throw new Error(`Failed to load memory links: ${linksError.message}`);
      }

      for (const link of links ?? []) {
        if (!linkedIdsByMemory.has(link.source_id)) linkedIdsByMemory.set(link.source_id, new Set());
        if (!linkedIdsByMemory.has(link.target_id)) linkedIdsByMemory.set(link.target_id, new Set());
        linkedIdsByMemory.get(link.source_id)!.add(link.target_id);
        linkedIdsByMemory.get(link.target_id)!.add(link.source_id);
      }
    }

    const memoriesWithLinks = scoredMemories.map((m) => ({
      ...m,
      linked_memory_ids: Array.from(linkedIdsByMemory.get(m.id) ?? []),
    }));

    if (scoredMemories.length > 0) {
      const incrementResults = await Promise.all(
        scoredMemories.map((memory) =>
          supabase
            .from("memories")
            .update({ access_count: (memory.access_count ?? 0) + 1 })
            .eq("id", memory.id)
        )
      );
      const incrementError = incrementResults.find((result) => result.error)?.error;
      if (incrementError) {
        throw new Error(`Failed to update access counts: ${incrementError.message}`);
      }
    }

    return {
      content: [
        { type: "text", text: `Loaded ${memories.length} memory row(s) for "${project}".` },
      ],
      structuredContent: { memories: memoriesWithLinks },
    };
  }
);

// --- save_memory ---------------------------------------------------------

const memoryTypeEnum = z.enum([
  "decision",
  "rejection",
  "constraint",
  "discovery",
]);

server.registerTool(
  "save_memory",
  {
    title: "Save Memory",
    description:
      "Persist a piece of project memory (decision, rejection, constraint, or discovery).",
    inputSchema: {
      project: z.string().describe("Project identifier"),
      type: memoryTypeEnum.describe("Category of memory being saved"),
      content: z.string().describe("The memory content to save"),
    },
  },
  async ({ project, type, content }) => {
    const { data: existingRows, error: existingError } = await supabase
      .from("memories")
      .select("id, content")
      .eq("project", project)
      .eq("resolved", false);

    if (existingError) {
      throw new Error(`Failed to load memories: ${existingError.message}`);
    }

    const existingMemories = existingRows ?? [];
    const decision = decideSaveAction(content, existingMemories);

    if (decision.action === "duplicate") {
      return {
        content: [{ type: "text", text: "Duplicate memory detected — skipping." }],
        structuredContent: {
          saved: false,
          reason: "duplicate",
          matched_id: decision.matchedId,
        },
      };
    }

    if (decision.action === "superseded") {
      const { error: resolveError } = await supabase
        .from("memories")
        .update({ resolved: true })
        .eq("id", decision.oldId);

      if (resolveError) {
        throw new Error(`Failed to resolve superseded memory: ${resolveError.message}`);
      }
    }

    const { data: inserted, error } = await supabase
      .from("memories")
      .insert({ project, type, content })
      .select("id")
      .single();

    if (error || !inserted) {
      throw new Error(`Failed to save memory: ${error?.message ?? "no row returned"}`);
    }

    const newMemoryId = inserted.id;
    const links = computeMemoryLinks(newMemoryId, content, existingMemories);

    if (links.length > 0) {
      const { error: linkError } = await supabase.from("memory_links").insert(links);
      if (linkError) {
        throw new Error(`Failed to save memory links: ${linkError.message}`);
      }
    }

    if (decision.action === "superseded") {
      return {
        content: [{ type: "text", text: `Superseded previous memory [${decision.oldId}].` }],
        structuredContent: { saved: true, action: "superseded", old_id: decision.oldId },
      };
    }

    return {
      content: [{ type: "text", text: "Memory saved." }],
      structuredContent: { saved: true, action: "created" },
    };
  }
);

// --- search_past_solutions -------------------------------------------------

server.registerTool(
  "search_past_solutions",
  {
    title: "Search Past Solutions",
    description:
      "Search previously recorded memory/fixes for a project matching a query.",
    inputSchema: {
      project: z.string().describe("Project identifier"),
      query: z.string().describe("Search query"),
    },
  },
  async ({ project, query }) => {
    void query;

    const { data, error } = await supabase
      .from("execution_log")
      .select("*")
      .eq("project", project)
      .eq("resolved", false);

    if (error) {
      throw new Error(`Failed to search past solutions: ${error.message}`);
    }

    const results = data ?? [];
    return {
      content: [{ type: "text", text: `Found ${results.length} result(s).` }],
      structuredContent: { results },
    };
  }
);

// --- record_fix ----------------------------------------------------------

server.registerTool(
  "record_fix",
  {
    title: "Record Fix",
    description: "Record a problem and its solution for future reference.",
    inputSchema: {
      project: z.string().describe("Project identifier"),
      problem: z.string().describe("Description of the problem"),
      solution: z.string().describe("Description of the solution/fix"),
    },
  },
  async ({ project, problem, solution }) => {
    const { error } = await supabase
      .from("execution_log")
      .insert({ project, problem, solution, resolved: false });

    if (error) {
      throw new Error(`Failed to record fix: ${error.message}`);
    }

    const saved = true as const;
    return {
      content: [{ type: "text", text: "Fix recorded." }],
      structuredContent: { saved },
    };
  }
);

// --- analyze_codebase ------------------------------------------------------

server.registerTool(
  "analyze_codebase",
  {
    title: "Analyze Codebase",
    description:
      "Build a lightweight AST index of a project's .ts/.js files (functions, classes, imports) into a local SQLite database at <project_path>/.coding-memory/ast-index.db.",
    inputSchema: {
      project_path: z.string().describe("Absolute or relative path to the project to index"),
    },
  },
  async ({ project_path }) => {
    const summary = analyzeCodebase(project_path);
    return {
      content: [
        {
          type: "text",
          text: `Indexed ${summary.files_indexed} file(s): ${summary.functions} function(s), ${summary.classes} class(es).`,
        },
      ],
      structuredContent: summary,
    };
  }
);

// --- get_file_summary --------------------------------------------------------

server.registerTool(
  "get_file_summary",
  {
    title: "Get File Summary",
    description:
      "Look up the functions and classes recorded for a file in the project's AST index. Requires analyze_codebase to have been run first.",
    inputSchema: {
      project_path: z.string().describe("Path to the project that was indexed"),
      file_name: z.string().describe("File name or relative path to look up"),
    },
  },
  async ({ project_path, file_name }) => {
    const summary = getFileSummary(project_path, file_name);
    return {
      content: [
        {
          type: "text",
          text: `${summary.file_path}: ${summary.functions.length} function(s), ${summary.classes.length} class(es).`,
        },
      ],
      structuredContent: summary,
    };
  }
);

// --- find_dependencies ----------------------------------------------------

server.registerTool(
  "find_dependencies",
  {
    title: "Find Dependencies",
    description:
      "Look up what a file imports, based on the project's AST index. Requires analyze_codebase to have been run first.",
    inputSchema: {
      project_path: z.string().describe("Path to the project that was indexed"),
      file_name: z.string().describe("File name or relative path to look up"),
    },
  },
  async ({ project_path, file_name }) => {
    const deps = findDependencies(project_path, file_name);
    return {
      content: [
        { type: "text", text: `${deps.file_path} imports ${deps.imports.length} module(s).` },
      ],
      structuredContent: deps,
    };
  }
);

// --- transport -------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("coding-memory MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error starting coding-memory MCP server:", error);
  process.exit(1);
});
