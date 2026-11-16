# Agent Note: Native provider readFile

Status: implemented

## Problem

Native sessions cannot serve the application's existing read-file route. Reusing the model's line-oriented Read tool would leave binary input, byte truncation, host permission semantics, and read-state unimplemented. A plain filesystem read would also bypass the effective tool profile and allow cwd-internal symlinks to escape the workspace.

## Decision

`NativeSession.readFile` and `seedReadState` implement the existing `FileReadResult` contract. Read targets resolve with lexical and realpath containment, must be ordinary files, follow effective Read allow/deny rules and the permission broker, and stream at most `maxBytes + 1` raw bytes. UTF-8 output ends at a complete codepoint; base64 carries the retained byte prefix. Missing or denied reads collapse to `available: false`, while real I/O, encoding, and lifecycle errors remain errors.

Only complete reads establish per-`NativeSession` read-state, and the observation binds the returned bytes to one opened `FileHandle` whose identity matches the resolved target before and after the read. A later manager stat cannot certify a different version: the seed also matches the retained observation and the current identity. Relative paths resolve against session cwd in both the provider and the manager's seed stat. Edit is capped at 8 MiB and uses the same writable handle for validation, its bounded internal read, positioned truncate/write, and verified readback, so neither path replacement nor external content becomes edit evidence. Host reads honor field-wise effective tool rules and `allowedTools`, and reject permission callbacks that rewrite the requested target or options. Model Read uses bounded streaming, fatal UTF-8/NUL checks, and contiguous multi-window coverage for files over 2000 lines.

Read-state, pending observations, and partial-read candidates share a 256-real-target LRU. Later partial or failed reads do not create or revoke still-current state, while every Edit revalidates an older observation. In-place auto-compact retains state; clear-with-seed replacement, plain clear, resume, and fork require a fresh read. Read-state is not durable conversation history and produces no message, git, capacity, or session-log event. The full contract is in [the design document](../../../../docs/superpowers/specs/2026-11-16-native-read-file-design.md).

## Alternatives considered

- **Wrap `fs.readFile` directly.** This would ignore profile permissions, symlink containment, bounded I/O, and the SDK's denied/missing contract.
- **Reuse the model Read tool's line-numbered output.** That output is text-only and windowed, so it cannot provide raw base64 or prove a complete read.
- **Copy DSH's oversized-file error.** The existing SDK-shaped route requires `truncated: true` with retained content instead of an oversize error.
- **Make seedReadState a no-op.** A no-op cannot protect Edit from truncated or stale content, which is the point of the manager's existing seed path.
- **Persist read-state across resume/fork.** Persisted version evidence could authorize edits against a file that changed while no session was live; new sessions must reread.
- **Change every write tool in the same project.** Write, NotebookEdit, and Bash need separate policy design and are not required for readFile compatibility.

## Consequences

Read-before-edit intentionally tightens native Edit behavior: missing, partial, stale, invalid, NUL-containing, or over-limit evidence rejects before mutation, and successful edits refresh evidence only after exact same-handle readback. Replacement sessions pay for a fresh complete read, while in-place compaction avoids that cost. The 256-target bound and 1 MiB/2000-line Read windows bound retained evidence and per-call model output; Edit's original, computed replacement, and readback each have an 8 MiB hard limit, with overflow computed from UTF-8 byte counts before replacement allocation.

Realpath and repeated identity checks are not an OS sandbox and do not eliminate every filesystem race. They deliberately reject unstable files instead of claiming rollback or certifying concurrent content. Focused unit, race-controlled `FileHandle`, provider/session, real-manager recovery, and REST coverage pin the behavior, including same-size/same-mtime replacement, multi-window reads, LRU eviction, in-place compact retention, and clear/resume/fork invalidation.
