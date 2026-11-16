# Agent Note: Native provider readFile

Status: proposed

## Problem

Native sessions cannot serve the application's existing read-file route. Reusing the model's line-oriented Read tool would leave binary input, byte truncation, host permission semantics, and read-state unimplemented. A plain filesystem read would also bypass the effective tool profile and allow cwd-internal symlinks to escape the workspace.

## Proposal

Implement `NativeSession.readFile` and `seedReadState` behind the existing `FileReadResult` contract. Resolve existing read targets with lexical and realpath containment, require ordinary files, apply the effective Read allow/deny rules and permission broker, and stream at most `maxBytes + 1` raw bytes. UTF-8 output ends at a complete codepoint; base64 carries the retained byte prefix. Missing or denied reads collapse to `available: false`, while real I/O, encoding, and lifecycle errors remain errors.

Only complete reads establish per-NativeSession read-state, and the observation must bind the returned bytes to one opened `FileHandle` whose identity matches the resolved target before and after the read. A later manager stat cannot certify a different version: the seed must also match the retained observation and the current identity. Relative paths resolve against session cwd in both the provider and the manager's seed stat. Edit is capped at 8 MiB and uses the same handle for validation, its internal read, positioned truncate/write, and verified readback, so neither path replacement nor external content can become edit evidence. Host reads honor field-wise effective tool rules and `allowedTools`, and reject permission callbacks that rewrite the requested target or options. Model Read uses bounded streaming, fatal UTF-8/NUL checks, and contiguous multi-window coverage for files over 2000 lines.

Read-state, pending observations, and partial-read candidates share a 256-target LRU. Later partial or failed reads do not create or revoke state, while every Edit still revalidates an older observation. In-place auto-compact retains state; clear-with-seed replacement, resume, and fork require a fresh read. Read-state is not durable conversation history. The full contract is in [the design document](../../../../docs/superpowers/specs/2026-11-16-native-read-file-design.md).

## Alternatives considered

- **Wrap `fs.readFile` directly.** This would ignore profile permissions, symlink containment, bounded I/O, and the SDK's denied/missing contract.
- **Reuse the model Read tool's line-numbered output.** That output is text-only and windowed, so it cannot provide raw base64 or prove a complete read.
- **Copy DSH's oversized-file error.** The existing SDK-shaped route requires `truncated: true` with retained content instead of an oversize error.
- **Make seedReadState a no-op.** A no-op cannot protect Edit from truncated or stale content, which is the point of the manager's existing seed path.
- **Persist read-state across resume/fork.** Persisted version evidence could authorize edits against a file that changed while no session was live; new sessions must reread.
- **Change every write tool in the same project.** Write, NotebookEdit, and Bash need separate policy design and are not required for readFile compatibility.

## Acceptance criteria

- The existing REST and manager paths return native UTF-8/base64 content with correct truncation and unavailable behavior.
- Effective Read allow/deny rules, permissionMode, realpath containment, and session cancellation all apply without an assistant-flush barrier.
- Only complete reads seed current-version state; Edit rejects missing, partial, or stale evidence and refreshes state after success.
- `supportsReadFile` turns on only after all behavior and recovery tests pass, with no new dependency or transcript capacity events.

## Risks

- Read-before-edit intentionally tightens existing native Edit behavior and requires updating old tests to establish a valid read first.
- Realpath checks are not an OS sandbox and cannot eliminate every filesystem race.
- Read-state remains isolated in each NativeSession, so resuming or forking requires a fresh complete read even when the log contains older file content.
