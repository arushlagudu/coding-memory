# coding-memory

An MCP server (and CLI) that gives AI coding agents persistent, project-scoped memory of decisions, fixes, and codebase structure.

## The problem

AI coding agents lose all context the moment a session ends — every new chat re-derives decisions, re-discovers constraints, and re-debugs errors it already solved last week. That's expensive in tokens and worse in outcomes: agents repeat rejected approaches, break constraints nobody remembered to restate, and re-explore a codebase's structure from scratch every single time.

## How it works

- **Session memory** — decisions, constraints, and discoveries are saved as typed memories and reloaded at the start of every session.
- **Execution log** — problems and their fixes are recorded so agents stop repeating solved mistakes.
- **Semantic linking** — new memories are automatically connected to related prior memories, forming a lightweight knowledge graph instead of a flat list.

## Install

1. Clone the repo
2. `npm install`
3. Create `.env` with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
4. `npm run build`
5. `sudo npm link`
6. `sudo npm install -g tsx`

## Commands

| Command | What it does |
|---|---|
| `cm start <project>` | Loads all unresolved memories for a project, grouped by type, with linked memory ids shown |
| `cm save <project> <type> <content>` | Saves a decision, rejection, constraint, or discovery, and auto-links it to related memories |
| `cm fix <project> <problem> <solution>` | Records a problem and its solution to the execution log |
| `cm analyze <project> <path>` | Builds an AST index (files, functions, classes) for a codebase |
| `cm search <project> <query>` | Searches both memories and past fixes matching a query |
| `cm resolve <project> <memory-id>` | Marks a memory as resolved |
| `cm delete <project> <memory-id>` | Deletes a memory and any links referencing it |
| `cm help` | Prints all available commands |

## Research backing

- **Codebase-Memory: Tree-Sitter-Based Knowledge Graphs for LLM Code Exploration via MCP** (arXiv:2603.27277, Mar 2026) — AST-based codebase indexing achieves 83% answer quality at 10x fewer tokens than file-by-file exploration.
- **Feedback-Normalized Developer Memory for Reinforcement-Learning Coding Agents: A Safety-Gated MCP Architecture** (arXiv:2605.01567, May 2026) — tracks terminal errors and failed fixes across sessions so agents don't repeat mistakes.
- **A-MEM: Agentic Memory for LLM Agents** (arXiv:2502.12110, NeurIPS 2025) — Zettelkasten-inspired memory network where new memories auto-link to related prior memories.
