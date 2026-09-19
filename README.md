# coding-memory

AI coding agents forget everything between sessions. Every new chat re-derives decisions, re-breaks constraints, and re-debugs errors it already fixed last week.

coding-memory is an MCP server (and CLI) that stores that context in Supabase and hands it back at the start of the next session.

## How it works

There are three tables, not one blob of text.

Memories: decisions, constraints, and discoveries, typed and scoped to a project.

Execution log: problems and their fixes, so an agent that already spent 20 minutes on a tsc error doesn't spend another 20 minutes on it next week.

Memory links: when you save a memory, it gets compared against recent memories for shared terms and auto-linked to the ones that overlap. No manual tagging.

## Install

```
git clone https://github.com/yourname/coding-memory.git
cd coding-memory
npm install
```

Create `.env`:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

Build and link the CLI:

```
npm run build
sudo npm link
sudo npm install -g tsx
```

Now `cm` is on your PATH.

## Commands

```
cm start <project>
cm save <project> <type> <content>
cm fix <project> <problem> <solution>
cm analyze <project> <path>
cm search <project> <query>
cm resolve <project> <memory-id>
cm delete <project> <memory-id>
cm help
```

### cm start

Loads everything unresolved for a project, grouped by type, with links shown underneath.

```
$ cm start myapp
Loaded 2 memory(ies) for "myapp".

Decisions (1)
-------------
  [294fba3a-aef3-472a-933f-b6bfd41c7cfa] Use Supabase for persistence layer
      linked: 793a0053-83b6-463a-9e6d-df8b7c2fbed8

Constraints (1)
---------------
  [793a0053-83b6-463a-9e6d-df8b7c2fbed8] Service role key must never be exposed to a client
      linked: 294fba3a-aef3-472a-933f-b6bfd41c7cfa
```

### cm save

```
$ cm save myapp decision "Use ilike search across memories and execution_log"
Saved decision [294fba3a-aef3-472a-933f-b6bfd41c7cfa] for "myapp".
```

`type` is one of `decision`, `rejection`, `constraint`, `discovery`.

### cm fix

```
$ cm fix myapp "tsc failed with Node16 module resolution error" "switched moduleResolution to Node16"
Fix recorded for "myapp".
```

### cm search

Searches memories and past fixes at the same time.

```
$ cm search myapp "module resolution"
Memories (0)
No results found

Past Fixes (1)
  Problem:  tsc failed with Node16 module resolution error
  Solution: switched moduleResolution to Node16
```

### cm analyze

Walks the project with tree-sitter and indexes functions, classes, and imports into a local sqlite file at `.coding-memory/ast-index.db`.

```
$ cm analyze myapp .
Indexed 7 file(s):
  functions: 24
  classes:   0
```

### cm resolve / cm delete

```
$ cm resolve myapp 294fba3a-aef3-472a-933f-b6bfd41c7cfa
Resolved memory [294fba3a-aef3-472a-933f-b6bfd41c7cfa]

$ cm delete myapp 793a0053-83b6-463a-9e6d-df8b7c2fbed8
Deleted memory [793a0053-83b6-463a-9e6d-df8b7c2fbed8]
```

`delete` also removes any memory_links pointing at that id, so you don't end up with dangling links.

## Research

Codebase-Memory: Tree-Sitter-Based Knowledge Graphs for LLM Code Exploration via MCP (arXiv:2603.27277). AST-based codebase indexing hits 83% answer quality at 10x fewer tokens than file-by-file exploration.

Feedback-Normalized Developer Memory for Reinforcement-Learning Coding Agents: A Safety-Gated MCP Architecture (arXiv:2605.01567). Tracks terminal errors and failed fixes across sessions so agents don't repeat mistakes.

A-MEM: Agentic Memory for LLM Agents (arXiv:2502.12110, NeurIPS 2025). Zettelkasten-inspired memory network where new memories auto-link to related prior memories.
