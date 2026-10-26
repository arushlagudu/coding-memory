# coding-memory — Agent Memory

This project uses stackmem for persistent agent memory.
Run `cm start coding-memory` at the start of every session
to load relevant context.

## Key decisions, constraints and discoveries

Decisions, constraints, discoveries, and rejections live in the stackmem
backend, not duplicated in this file — run `cm start coding-memory` to load
the current list.

When you make a decision, discover a constraint, reject an approach, or
make a discovery during this session, save it with:
cm save coding-memory <type> "<content>"
