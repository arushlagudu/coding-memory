#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

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
    return {
      content: [
        { type: "text", text: `Loaded ${memories.length} memory row(s) for "${project}".` },
      ],
      structuredContent: { memories },
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
    const { error } = await supabase
      .from("memories")
      .insert({ project, type, content });

    if (error) {
      throw new Error(`Failed to save memory: ${error.message}`);
    }

    const saved = true as const;
    return {
      content: [{ type: "text", text: "Memory saved." }],
      structuredContent: { saved },
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
