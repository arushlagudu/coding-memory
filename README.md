# stackmem

Persistent memory for AI coding agents. Zero config. Installs in 60 seconds.

## The problem

Every session with an AI coding agent starts from zero. You re-explain the same stack, the same constraints, the same "we tried that and it didn't work" — and the agent repeats mistakes it already made last week, because nothing it learned last session survived the chat closing.

## Install

```
npm install -g stackmem
```

## Setup

```
cd myproject
cm init myapp .
```

```
✓ .gitignore created
✓ Git hook installed
✓ MCP server registered
✓ CLAUDE.md written
✓ .cursorrules written
✓ .windsurfrules written
✓ Seeded 2 memories from project scan
✓ Backend connection verified

stackmem is live. Open Claude Code and ask "what do you know about this project?" to verify.
```

That's it. Open Claude Code and ask "what do you know about this project?" to verify.

## How it works

Four layers, each feeding the next:

- **Capture** — a git post-commit hook saves memories automatically on every commit: removed dependencies, new config files, auth-related files, TODOs, schema changes, and the commit message itself when it's substantive. No manual annotation. **97.9% automation rate** across stackmem's own real development history.
- **Semantic organization** — hybrid containment-trigram scoring deduplicates new memories against existing ones, links related memories bidirectionally, and resolves contradictions ("we switched from X to Y") automatically.
- **Temporal ranking** — an exponential decay score ranks memories by recency and access frequency, then a 2000-token budget decides what actually gets injected.
- **Delivery** — an MCP server, an 18-command CLI, and the Memory Vault web dashboard all read from the same store and deliver it back into every new session.

## Claude Code (automatic)

`cm init` registers the stackmem MCP server in `~/.claude.json`. Memories load automatically at the start of every session — nothing to configure, nothing to remember to run.

## Cursor and Windsurf (automatic)

`cm init` writes `.cursorrules` and `.windsurfrules` directly from your project's live memories, and the git hook keeps them current — `cm sync` regenerates and commits both files automatically after every push. You never have to remember to refresh them by hand.

```
# stackmem — project memory (auto-updated)
## Project: myapp

### Constraints
- required env vars: DATABASE_URL, API_KEY

### Discoveries
- tech stack: express

---
*Last updated: 10/13/2026, 5:37:45 PM*
*Run `cm start` for full details with decay scores*
```

## CLI commands (all 18)

| Command | Description |
|---|---|
| `cm start [project]` | Load all unresolved memories, decay-ranked and budget-capped, grouped by type with linked memory ids. |
| `cm save [project] <type> <content>` | Save a new memory (`decision`, `constraint`, `discovery`, or `rejection`). Links to related memories automatically; prompts on contradiction unless `--force`. |
| `cm fix [project] <problem> <solution>` | Record a problem and its solution for future reference. |
| `cm analyze [project] <path>` | Build a Tree-Sitter AST index (files, functions, classes) for the codebase. |
| `cm search [--project <name>] <query>` | Search memories and past fixes for a project matching a query. |
| `cm resolve [project] <memory-id>` | Mark a memory as resolved. |
| `cm delete [project] <memory-id>` | Delete a memory and any links referencing it. |
| `cm inspect [project] <memory-id>` | Show a single memory's full detail: type, content, decay score, access count, linked memories, and related fixes. |
| `cm compress [project]` | Cluster related memories (needs 20+) and collapse clusters of 3+ into a summary memory. |
| `cm init <project> <path>` | Install the git hook, register the MCP server, seed memories from the project scan, and write `.gitignore`, `CLAUDE.md`, `.cursorrules`, and `.windsurfrules`. |
| `cm sync` | Regenerate `.cursorrules` and `.windsurfrules` from current memories and recent fixes. |
| `cm context [--project <name>] <task>` | Return the top 5 memories most relevant to a specific task, capped at 2000 tokens. |
| `cm session-end [project]` | Capture what happened in a session and extract memories, errors, and rejected approaches. |
| `cm doctor` | Check every integration point — backend, MCP registration, `.stackmem`, git hook, memory count — and report what's broken. |
| `cm undo [project]` | Delete the most recently saved unresolved memory. |
| `cm export [filename]` | Export all unresolved memories, fixes, and links to a JSON file. |
| `cm import [project] <filename>` | Import memories and fixes from a file produced by `cm export`. |
| `cm help` | Show the full help message. |

## The Memory Vault

`stackmem-vault.vercel.app`

Sign in with GitHub. View every project you track, each with its memory count and last activity. Four tabs per project: **Memories** (typed, with decay scores and resolve/delete actions), **Fixes** (problem/solution pairs), **Graph** (a D3.js force-directed view of your actual knowledge network — nodes are memories, edges are semantic links), and **Timeline** (every memory chronologically, including resolved ones). A global search bar queries memories and fixes across every project at once.

## How memory works

Memories are decisions, constraints, discoveries, and rejections, scoped to a project. Fixes are stored separately as a problem string and the solution that closed it, so the same error doesn't cost another 20 minutes next month.

Every save checks new content against existing memories with a **hybrid score**: 0.7 × entity containment (shared terms over the size of the smaller set) + 0.3 × character-trigram Jaccard overlap. The trigram component catches lexical near-misses that containment alone can't — e.g. `"removed dependency: node:path"` vs `"removed dependency: node:url"`, which share identical entity sets but diverge in the actual package name. Above 0.85 with no negation word, it's a duplicate and gets skipped. With a negation word like "switched" or "no longer" and a score above 0.4, it's a contradiction.

`cm save` stops and asks whether to keep the old memory or replace it, unless `--force` is passed. The MCP `save_memory` tool always replaces automatically, since nothing is watching stdin on that path.

New memories are also compared against everything else and linked above a lower threshold of 0.15, using the same hybrid score. `cm start` and `cm context` show those links without any manual tagging.

Relevance decays over time: `score = (1 + ln(1 + accessCount)) * exp(-0.05 * daysSinceCreated)`. Frequently accessed memories decay slower, but nothing survives forever. The 0.05 constant works out to roughly a 14-day half life.

`cm start` and `cm context` cap output at 2000 tokens. They fill from the highest-ranked memory down until the next one would push past that limit.

Past 20 unresolved memories, `cm compress` clusters related memories by hybrid score above 0.2 using union-find. Clusters of 3 or more collapse into a single summary memory.

## Benchmark results

Measured against stackmem's own real production data — not synthetic fixtures.

| Metric | Result |
|---|---|
| Token reduction vs. full codebase dump | 99.4% (36,579 → 226 tokens) |
| Duplicate detection F1 | 0.974 (P=1.00, R=0.95) |
| Contradiction detection F1 | 0.947 (P=1.00, R=0.90) |
| Semantic linking SNR | 7.8x (linked: 0.69, random: 0.09) |
| Automation rate | 97.9% (47/48 memories auto-captured) |

## Research

Ideas taken from a few papers, not implementations of them.

- Codebase-Memory: Tree-Sitter-Based Knowledge Graphs for LLM Code Exploration via MCP (arXiv:2603.27277)
- Feedback-Normalized Developer Memory for Reinforcement-Learning Coding Agents (arXiv:2605.01567)
- A-MEM: Agentic Memory for LLM Agents (arXiv:2502.12110, NeurIPS 2025)
- SWE-MeM: Learning Adaptive Memory Management for Long-Horizon Coding Agents (arXiv:2606.28434)
- AtomMem: Learnable Dynamic Agentic Memory with Atomic Memory Operation (arXiv:2601.08323)

## Paper

[stackmem: MCP, Tree-Sitter AST Graphs, Hybrid Containment-Trigram Scoring, and Temporal Decay for Persistent AI Coding Agent Memory](https://github.com/arushlagudu/coding-memory/blob/main/docs/paper.pdf)
