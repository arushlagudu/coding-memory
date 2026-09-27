# stackmem

AI agents forget everything between sessions. Every new chat re-derives decisions, re-breaks constraints that were already settled, and re-debugs errors that were already fixed last week.

stackmem is a CLI and an MCP server that stores that context in Supabase and hands it back at the start of the next session. A git post-commit hook captures most of it automatically.

## Install

```
npm install -g stackmem
```

Then in any git repo:

```
cm init <project> .
```

That's it. No config, no accounts, no env file.

## Usage

```
cm start <project>
cm save <project> <type> <content> [--force]
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

`type` is one of `decision`, `rejection`, `constraint`, `discovery`.

```
$ cm save myapp decision "Use ilike search across memories and execution_log"
Saved decision [294fba3a-aef3-472a-933f-b6bfd41c7cfa] for "myapp".
```

If the new content contradicts something already stored, it asks first.

```
$ cm save myapp decision "We switched from Supabase to Postgres directly"
Conflict detected:
  Old: Use Supabase for persistence layer
  New: We switched from Supabase to Postgres directly

Keep old or replace? (k/r): r
Replaced with new memory [b1a2c3d4-5678-90ab-cdef-1234567890ab].
```

`--force` skips the prompt and always replaces. Use it from scripts.

```
$ cm save myapp decision "We switched from Supabase to Postgres directly" --force
Replaced with new memory [b1a2c3d4-5678-90ab-cdef-1234567890ab].
Saved decision [b1a2c3d4-5678-90ab-cdef-1234567890ab] for "myapp".
```

### cm fix

```
$ cm fix myapp "tsc failed with Node16 module resolution error" "switched moduleResolution to Node16"
Fix recorded for "myapp".
```

### cm analyze

```
$ cm analyze myapp .
Indexed 7 file(s):
  functions: 24
  classes:   0
```

Runs tree-sitter over the project and writes an AST index to `.coding-memory/ast-index.db`.

### cm search

Checks memories and past fixes in the same query.

```
$ cm search myapp "module resolution"
Memories (0)
No results found

Past Fixes (1)
  Problem:  tsc failed with Node16 module resolution error
  Solution: switched moduleResolution to Node16
```

### cm resolve / cm delete

```
$ cm resolve myapp 294fba3a-aef3-472a-933f-b6bfd41c7cfa
Resolved memory [294fba3a-aef3-472a-933f-b6bfd41c7cfa]

$ cm delete myapp 793a0053-83b6-463a-9e6d-df8b7c2fbed8
Deleted memory [793a0053-83b6-463a-9e6d-df8b7c2fbed8]
```

`delete` also removes any memory_links pointing at that id.

### cm context

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

Top 5 memories relevant to a task, ranked by relevance and decay, capped at 2000 tokens. Feed this to an agent instead of the whole project's memory.

### cm compress

```
$ cm compress myapp
Compressed 4 memories into 1 summary
Compressed 3 memories into 1 summary
Compression complete. 2 clusters compressed.
```

Needs 20+ unresolved memories. Also runs automatically once a project crosses that count.

### cm init

```
$ cm init myapp .
coding-memory hook installed for project myapp at .
```

Installs a post-commit hook that calls `dist/cli.js save` after every commit with the commit message, plus whatever the diff turns up: removed imports, new env vars, new auth files, package.json changes, new config files, schema files, TODOs.

### cm help

```
$ cm help
cm — coding memory CLI

  cm start <project>
      Load all unresolved memories for a project, sorted by decay
      score and capped at a 2000 token context budget.

  cm save <project> <type> <content> [--force]
      Save a new memory. Prompts before overwriting a contradiction
      unless --force is passed.

  ...
```

## How it works

Memories are decisions, constraints, discoveries, and rejections, scoped to a project. Fixes are stored separately as a problem string and the solution that closed it, so the same tsc error doesn't cost another 20 minutes next month.

Every save checks new content against existing memories with a containment score: shared terms over the size of the smaller set. Above 0.85 with no negation word, it's a duplicate and gets skipped. With a negation word like "switched" or "no longer" and a score above 0.4, it's a contradiction.

cm save stops and asks whether to keep the old memory or replace it, unless `--force` is passed. The MCP `save_memory` tool always replaces automatically, since nothing is watching stdin on that path.

New memories are also compared against everything else and linked above a lower threshold of 0.15. `cm start` and `cm context` show those links without any manual tagging.

Relevance decays over time: `score = (1 + ln(1 + accessCount)) * exp(-0.05 * daysSinceCreated)`. Frequently accessed memories decay slower, but nothing survives forever. The 0.05 constant works out to roughly a 14-day half life.

`cm start` and `cm context` cap output at 2000 tokens. They fill from the highest-ranked memory down until the next one would push past that limit.

Past 20 unresolved memories, `cm compress` clusters related memories by containment score above 0.2 using union-find. Clusters of 3 or more collapse into a single summary memory.

## Research

Ideas taken from a few papers, not implementations of them.

- Codebase-Memory: Tree-Sitter-Based Knowledge Graphs for LLM Code Exploration via MCP (arXiv:2603.27277)
- Feedback-Normalized Developer Memory for Reinforcement-Learning Coding Agents (arXiv:2605.01567)
- A-MEM: Agentic Memory for LLM Agents (arXiv:2502.12110, NeurIPS 2025)
- SWE-MeM: Learning Adaptive Memory Management for Long-Horizon Coding Agents (arXiv:2606.28434)
- AtomMem: Learnable Dynamic Agentic Memory with Atomic Memory Operation (arXiv:2601.08323)
