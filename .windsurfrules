# stackmem — project memory (auto-updated)
## Project: coding-memory

### Decisions
- docs: rewrite README to reflect current product v1.0.21
- docs: final paper PDF with clean ASCII diagram and author name
- docs: add full academic paper for arXiv submission
- feat: hybrid scoring, richer seeding, entity extraction fixes, improved benchmarks
- feat: write .cursorrules and .windsurfrules on cm init for Cursor and Windsurf support
- feat: cm inspect command with full link network and related fixes
- built stripe webhook handler with error handling
- feat: diff-first hierarchy, commit quality filter, first-commit fix
- feat: dynamic project name from .stackmem, fix init ordering, seed memories on init
- feat: Phase 1 — local rules sync, post-rewrite hook, SHA idempotency, diff cap, Node check, backoff, provenance, cm why, cm pin, task-aware start, .stackmem.json config
- feat: cm doctor, cm undo, cm export, cm import — Phase 4 and 5 complete
- feat: add cm link command for device linking
- feat: Phase 0 — cm uninstall, non-blocking hook, hook chaining, secret redaction, conventional commit routing, regression tests, cm doctor --fix

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- fix: add --force to git hook saves to prevent interactive prompts during commits
- feat: hosted Supabase backend, npm publish as stackmem, no env file required

### Constraints
- TypeScript config: target=ES2022, module=Node16

### Rejections
- removed dependency: ./config.js

### Discoveries
- project description: # stackmem Persistent memory for AI coding agents. Zero config. Installs in 60 seconds. ## The problem Every session with an AI coding agent starts from zero. You re-explain the same stack, the same constraints, the same "we tried that and it didn't work" — and the agent repeats mistakes it already made last week, because nothing it learned last session survived the chat closing. ## Install ``` npm install -g stackmem ``` ## Setup ``` cd myproject cm init myapp . ``` ``` ✓ .gitignore created ✓ Git hook installed ✓ MCP server registered ✓ CLAUDE.md written ✓ .cursorrules
- tech stack: @modelcontextprotocol/sdk, @supabase/supabase-js, better-sqlite3, tree-sitter, tree-sitter-javascript, tree-sitter-typescript, zod, @types/better-sqlite3, @types/node, tsx, typescript
- open issue from commit: // TODO: optimize the clustering algorithm
- open issue from commit: if (/TODO:|FIXME:|HACK:|XXX:/.test(codeLine)) {
- [DISCOVERY cluster] cluster: [DECISION cluster] chore: chore: remove dist from git tracki; [REJECTION cluster] node:fs: removed dependency: node:fs; re; [REJECTION cluster] node:path: removed dependency: node:path

### Recent Fixes
- webhook returned 400 → (solution pending)

---
*Last updated: 10/26/2026, 9:35:26 PM*
*Run `cm start` for full details with decay scores*
