# coding-memory

AI coding agents forget everything between sessions. Every new chat re-derives decisions, re-breaks constraints, and re-debugs errors it already fixed last week.

coding-memory is a CLI and MCP server that stores that context in Supabase and hands it back at the start of the next session — plus a git post-commit hook that captures a lot of it automatically, so you don't have to remember to call `cm save` yourself.

## How it works

- Session memory: decisions, constraints, discoveries, and rejections, typed and scoped to a project
- Execution log: problems and their fixes, so an agent that already spent 20 minutes on a tsc error doesn't spend another 20 minutes on it next week
- Semantic linking: new memories auto-link to related ones using containment scoring — no manual tagging
- Decay scoring: memories are ranked by recency and access frequency, so older unused memories rank lower and eventually drop out of context
- Git hook: commit messages, removed imports, new env vars, TODOs, package.json changes, new config files, and schema changes are captured automatically on every commit

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

Then, from inside the project you want tracked:

```
cd ~/code/myapp
cm init myapp .
```

This installs a post-commit hook that auto-saves memories on every commit — no need to call `cm save` by hand for the stuff the hook already catches.

## Commands

```
cm start <project>
cm save <project> <type> <content>
cm fix <project> <problem> <solution>
cm analyze <project> <path>
cm search <project> <query>
cm resolve <project> <memory-id>
cm delete <project> <memory-id>
cm context <project> <task>
cm compress <project>
cm init <project> <path>
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

### cm context

Returns only the top 5 memories most relevant to a specific task, blending task relevance with decay score, as a markdown block capped at the 2000 token budget. This is what you feed an agent instead of dumping the whole project's memory on it.

```
$ cm context myapp "fix the module resolution error in the build"
## Project Context: myapp
### Task: fix the module resolution error in the build

**Constraints**
- Service role key must never be exposed to a client

**Discoveries**
- schema change: migrations/003_add_access_count.sql

*(41/2000 tokens used)*
```

### cm compress

Clusters related unresolved memories (needs 20+) and collapses clusters of 3 or more into a single summary memory. Runs automatically past the threshold, but can be triggered by hand too.

```
$ cm compress myapp
Compressed 4 memories into 1 summary
Compressed 3 memories into 1 summary
Compression complete. 2 clusters compressed.
```

### cm init

Installs a git post-commit hook in the repo at `<path>` that runs `dist/cli.js save` after every commit, feeding it the commit message plus whatever the diff analysis picks up (removed imports, new env vars, new auth-related files, package.json additions/removals, new config files, schema/migration files, TODOs).

```
$ cm init myapp .
coding-memory hook installed for project myapp at .
```

## How it works under the hood

- Atomic CRUD: before a memory is inserted, it's checked against existing ones. A containment score above 0.85 with no negation word (e.g. "switched", "no longer") is treated as a duplicate and the insert is skipped. The same high-similarity match combined with a negation word is treated as a contradiction — the old memory is marked resolved and the new one is inserted in its place.
- Context budget: both `cm start` and `cm context` enforce a hard 2000 token limit. Memories are decay-ranked first, then added in that order until the next one would blow the budget.
- Compression: once a project crosses 20 unresolved memories, single-linkage clustering (containment score > 0.2, union-find merge) groups related memories, and clusters of 3+ collapse into a single summary memory.
- Decay formula: `score = (1 + ln(1 + accessCount)) * exp(-0.05 * daysSinceCreated)`. Frequently-accessed memories decay slower, but everything fades eventually — the 0.05 constant gives roughly a 14-day half-life.

## Research

Codebase-Memory: Tree-Sitter-Based Knowledge Graphs for LLM Code Exploration via MCP (arXiv:2603.27277). AST-based codebase indexing hits 83% answer quality at 10x fewer tokens than file-by-file exploration.

Feedback-Normalized Developer Memory for Reinforcement-Learning Coding Agents: A Safety-Gated MCP Architecture (arXiv:2605.01567). Tracks terminal errors and failed fixes across sessions so agents don't repeat mistakes.

A-MEM: Agentic Memory for LLM Agents (arXiv:2502.12110, NeurIPS 2025). Zettelkasten-inspired memory network where new memories auto-link to related prior memories.

SWE-MeM: Learning Adaptive Memory Management for Long-Horizon Coding Agents (arXiv:2606.28434, June 2026). Proactive compression framework — agents decide when and what to compress based on context budget, rather than compressing on a fixed schedule.

AtomMem: Learnable Dynamic Agentic Memory with Atomic Memory Operation (arXiv:2601.08323, Jan 2026). Treats CRUD operations as atomic decisions rather than blind inserts — the basis for the duplicate and contradiction detection above.
