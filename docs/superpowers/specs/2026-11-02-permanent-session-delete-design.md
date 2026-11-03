# Permanent Session Delete Design

## Intent

Give users a separate, explicit way to reclaim local transcript disk space while preserving the existing delete behavior for users who want the SDK/CLI conversation log to remain recoverable.

## Approved behavior

- Keep **Delete session** unchanged: remove app state but keep the SDK/CLI transcript.
- Add **Delete permanently** only to the session sidebar context menu and the chat-panel context menu. Do not add another SessionCard button.
- The permanent action calls `DELETE /api/sessions/:id?deleteTranscript=true` after a stronger destructive confirmation.
- Permanent deletion removes the main `<session-id>.jsonl`, its sibling `<session-id>/` directory (including subagent transcripts), app metadata/sidecars, and client caches.
- Missing transcript files are a successful no-op. Filesystem failures must surface as errors; the server must not broadcast `removed` or discard the persistence entry after a transcript-deletion failure.
- This is ordinary local file deletion, not secure erasure or backup cleanup.

## Implementation choices

- Reuse `findTranscriptFile()` so transcript lookup follows `CLAUDE_CONFIG_DIR` and the existing safe projects-tree scan.
- Add a strict transcript-artifacts deletion helper beside the existing best-effort `deleteTranscriptFile()`; do not change the `/clear` or discard behavior.
- Run transcript deletion after `unload()` releases CLI file handles and before worktree/metadata teardown. Remove the session directory before the main JSONL so a directory-removal failure leaves the locator file available for retry.
- Thread an optional `{ deleteTranscript?: boolean }` argument through the existing delete handler. Default `false` keeps Restart and all current callers unchanged.
