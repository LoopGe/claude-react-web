# AGENTS.md — Agent Notes

Agent Notes are durable decision records: why a choice was made, what it beat, and what it cost. They are ordinary Markdown read on demand, not a Claude Code discovery path.

- Follow the [Agent Note rules](README.md) for layout, the header block, and each lifecycle's skeleton.
- Every new note triggers a supersession check: search the active tree for older notes covering the same decision or mechanism, and cross-link partial supersessions.
- Run `npm run verify:agent-notes` after adding, moving, or editing a note.
- Repository-wide conventions live in [CLAUDE.md](../../CLAUDE.md).
