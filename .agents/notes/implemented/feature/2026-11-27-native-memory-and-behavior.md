# Agent Note: Native memory loading, behavior guidance, and Bash execution semantics

Status: implemented

## Problem

Two failures proven from real use in this repo, plus a guidance gap:

1. **Native sessions do not follow CLAUDE.md.** The root cause is structural,
   not behavioral: native loaded no memory files at all (the gap recorded in
   the [context-composition note](2026-11-25-native-context-composition.md)),
   so the repo's rules never reached the model.
2. **Every Bash call was prefixed with `cd <cwd>`.** Native's Bash already
   spawns each command with `cwd: ctx.cwd`, but nothing in the prompt stated
   the execution semantics: the tool description was "Run a shell command and
   return its output.", the guidance mentioned only exit codes, and the cwd
   appeared once in the opening `contextSnapshot` reminder. The model
   defensively re-`cd`'d because it lacked the semantics, not because it
   disobeyed a rule.
3. The CLI ships a full behavior/tone suite; native had none.

The [design spec](../../../../docs/superpowers/specs/2026-11-27-native-memory-and-behavior-design.md)
owns the full goal list; the
[CLI extracts reference](../../../../docs/superpowers/specs/2026-11-27-cli-prompt-extracts.md)
holds the pinned CLI 2.1.311 texts the adaptation draws from.

## Decision

### Memory chain through a seventh host port

`NativeMemoryPort` (`native/ports.ts`) is the seventh entry in
`NativeHostPorts`: `read(cwd)` returns
`{ files: NativeMemoryFile[] /* path, scope, content */, isGitRepo }` — a
neutral shape; the core never touches `fs` for memory and holds no
git/worktree concept. The implementation lives host-side in
`server/providers/native-host-memory.ts` (`createMemoryReader`), wired through
`native-host-adapters.ts` (a `deps.memory` override lets tests inject
fixture-backed readers).

The chain matches the CLI's core sources (order verified against the pinned
CLI 2.1.311 binary): the user file (`claudeConfigDir()/CLAUDE.md`, respecting
`CLAUDE_CONFIG_DIR`) first, then project ancestors root→cwd, each directory
contributing `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` in that
order. A normal `.git` directory records the repo root but the walk continues
(ancestors above the repo load too).

**Worktree-aware resolution (the user's option A, picked after the builder
check).** A `.git` POINTER FILE marks a linked worktree whose physical
ancestors are not the repo's ancestors. The reader parses the pointer's
`gitdir:` line — a pure file read, no git subprocess, because the origin path
is literally in the file — resolves the origin repo root
(`<origin>/.git/worktrees/<name>` → three dirnames up; a bare `<origin>/.git`
gitdir also resolves), and continues the chain from the origin root upward.
Files dedup by repo-relative path: the worktree's checked-out version wins,
the origin's same-relative file is skipped, while the origin's
`CLAUDE.local.md` and above-root ancestors still load. This covers both
manager-isolated worktrees (`<stateDir>/worktrees/<id>`, outside the repo)
and in-repo worktrees (`.claude/worktrees/<name>`) with no double injection.
The emitted order is **worktree's own files → origin root → origin
ancestors**, pinned by the normative reader tests (the out-of-repo fixture
expects worktree `CLAUDE.md`, origin `CLAUDE.local.md`, then the above-root
file, in that order). Nested pointer files are followed the same way, bounded
at 8 hops with a visited-set cycle guard; a malformed pointer warns and
degrades to a boundary stop — no jump, no upward continuation.

**Per-file cap and failure policy.** DSH's `DEFAULT_MAX_SOURCE_BYTES`
(1 MiB) is adopted per file: an over-cap file is skipped and logged, never
truncated into the prompt (a silently truncated rules file loses rules
without telling anyone). `ENOENT`/`ENOTDIR` are expected absent states and
skip silently; any other stat/read failure warns and skips — the session
never dies on an unreadable memory file, but the failure stays visible.
Symlinked candidates resolve through `stat` (not `lstat`), so a symlinked
CLAUDE.md pointing at a regular file loads.

**Freshness without a watcher.** The reader keeps a per-instance
(path → mtimeMs + size + content) cache; the core re-requests memory at every
turn start, so a turn-boundary re-read re-stats every candidate but only
re-reads files that actually changed. An edited CLAUDE.md takes effect on the
next turn without a respawn.

### Injection: per-turn system overlay, not a reminder message

The stable base (`renderSystem`, built once per session) is identity + the
seven behavior sections (orders 10–70) + tool guidance + `systemPromptAppend`.
The per-turn overlay (`native-session.ts` `turnSystem`) appends, in order:
persona instruction, `# Memory Files`, `# Environment`, `<available_skills>`;
plan guidance stays per-round, appended last. `prompt/overlay.ts` holds the
pure renderers; `joinPromptParts` drops empty parts, so an empty chain leaves
no section and no stray separator. The memory section renders one block per
file labelled with its absolute path and scope, in the order received (model
precedence) — never re-sorted.

The environment block states cwd, is-git-repo, platform, and the date at DAY
granularity, so the system prefix stays byte-stable across unchanged same-day
turns for prompt caching (pinned by a byte-equality test). The git fact rides
the memory read result (`isGitRepo`): the ancestor walk already stats every
`.git` marker, so no second git probe and no spawn-time cache are needed —
this resolves the git-probe seam the design left to the builder.

`memorySnapshot` caches the latest read: seeded fire-and-forget in the
constructor (warn-only, closed-guarded) so pre-turn readers like
`getContextUsage` see the chain without waiting for a turn; the per-turn read
is authoritative. Subagents inherit the parent's snapshot through
`subagentSystem` — nested runs never call the port themselves. Side chats
load memory identically (same cwd).

### Behavior sections

`prompt/behavior.ts` ports seven sections adapted from the pinned CLI's
texts: Communicating with the user, Tone and style, Doing tasks, Executing
actions with care, Delivering work, Corrections, Pronouns. Adaptation rule:
strip Claude Code product references and CLI-only mechanics, keep the
behavioral substance, never invent reasons. The generic secure-coding and
UI-verification bullets stay — they are generic agent behavior, not product
identity. The sections register in BOTH prompt variants (parent and
subagent), between identity and tool guidance.

### Bash: three layers, real reasons only

`tools/bash.ts` follows the CLI's three-layer approach with native's actual
semantics:

1. **Factual semantics in the description**: every call starts in the session
   working directory; a `cd` does not carry over to the next call, and shell
   state (env vars, functions) does not persist — native's true
   fresh-`shell -c`-per-call reality.
2. **Positive strategy in the guidance**: maintain the working directory via
   absolute paths; use `cd` only when the user explicitly requests it. The
   exit-code rule stays.
3. **The anti-pattern named with a REAL reason**: never prepend
   `cd <working-directory>` to a command (git especially) — it already runs
   in the session working directory, so the prefix is redundant. The CLI's
   permission-prompt rationale is deliberately NOT copied: native has no
   per-command permission mechanism for `cd` compounds, and a test pins the
   absence of that wording.

### Context composition

`getContextUsage` gains a **Memory Files** used-row (the CLI's display name),
priced with the same `estimateText` density rule + one role overhead; the
environment block prices inside the System prompt row. Both price the cached
`memorySnapshot`; a null snapshot (probe before the constructor seed lands)
omits both, and an empty chain omits the row. The
[context-composition note](2026-11-25-native-context-composition.md) is
updated in the same feature — its "native loads no memory files" premise is
superseded.

## Alternatives considered

**CLI-style system-reminder user message for memory.** The CLI injects
CLAUDE.md content as reminder messages in the history. Rejected: native's
system prompt is already session-stable and memory changes rarely; a system
section keeps the message history clean and the cache prefix stable, and the
turn-boundary mtime recheck gives the same freshness without a watcher or a
growing reminder trail.

**DSH's boundary-truncated worktree walk.** DSH's agent-instructions reader
stops at the first `.git` marker, so a worktree loads only its own checkout —
it accepts the gitignored-local/ancestor gap. This repo actively uses
worktrees, so the user chose repo-aware resolution (option A) over that gap.

**The literal full ancestor walk inside a worktree.** The physical ancestors
above a worktree root are not the repo's ancestors: for manager-isolated
worktrees the walk would climb the state dir's unrelated ancestors, and for
in-repo worktrees it would double-inject the origin's CLAUDE.md (checked-out
copy plus origin copy). Rejected in favor of pointer resolution + dedup.

**A git subprocess for origin resolution.** The origin path is literally in
the pointer file; a pure file read replaces the spawn and keeps the reader
cheap enough to run at every turn boundary.

**DSH's per-chain byte budget and AGENTS.md candidates.** Not adopted: the
CLI has no chain budget, and native loads CLAUDE.md only. The per-file 1 MiB
cap is the one DSH limit taken.

**A blunt "don't cd" prohibition, or the CLI's permission-prompt reason.**
The `cd` problem is a semantics gap; stating the facts is the actual fix. A
prohibition grounded in a mechanism native does not have would be a fake
reason — exactly what the adaptation rule forbids.

## Consequences

Native sessions receive the same CLAUDE.md rules as claude sessions, edits
land on the next turn, and worktree sessions get the worktree's checked-out
rules plus the origin's local/ancestor rules without double injection. The
Bash prefix behavior is addressed at its root (stated semantics) rather than
policed. The prompt grows by the memory chain + behavior suite + environment
block; the Context tab shows where it goes, and the stable base stays
session-stable with a byte-stable same-day overlay.

The neutral-core boundary holds: the seventh port crosses only neutral
shapes, the host-free pin extends to `native-host-memory`, and worktree
resolution stays entirely host-side. The reader's per-file entries (not one
concatenated blob) leave room for the deferred sources below without a
reshape. Costs: a per-turn re-stat of every candidate (content re-read only on
change), and a pre-turn Context probe before the constructor seed lands omits
memory/environment — the display-only non-atomicity documented in the
composition note.

## Deferred

Knowingly left out, with the reason:

- **`@path` import expansion and `.claude/rules/` loading** — the user
  confirmed they use neither today; the per-file entry shape leaves room to
  add them later.
- **Managed enterprise policy memory, auto-memory, AGENTS.md,
  additional-working-directories memory** — the CLI has them; local
  single-user usage here does not.
- **The security-policy / URL-guessing section and Claude Code product
  identity** — native keeps its own identity line.
- **A file watcher** — the mtime check at turn boundaries is the freshness
  mechanism.
- **A per-command permission mechanism for `cd` compounds** — it does not
  exist in native; the guidance states the real reason instead.

## Testing

The reader tests (`native-host-memory.test.ts`) are hermetic through two
host-factory seams: injected `configDir` (the developer's real `~/.claude` is
never read) and `fsRoot`, which bounds BOTH upward walks so fixture tests
never read real ancestors above their tmpdirs. `fsRoot` is a test-only dep on
`createMemoryReader` — absent means the real filesystem root (full CLI-parity
ancestor coverage), and the neutral port shape is unchanged. The fixtures pin
chain order, the three candidate variants, non-git cwds, missing-file skip,
over-cap skip, both worktree layouts (dedup, worktree-version-wins, origin
local recovery, nested-subdir cwd), mtime invalidation on a same-size rewrite,
the malformed-pointer boundary stop, and the fsRoot bound itself.

`native-session.test.ts` pins the overlay order (behavior < persona < memory
< environment < skills), a memory edit landing on the next turn, byte-stable
same-day system strings, empty-chain section omission, subagent inheritance
(memory + environment + behavior, without the Agent guidance), and the Memory
Files row summing into the used total / omitted when empty. Session tests
default to an empty memory stub so they never read the real chain.
`behavior.test.ts`, `overlay.test.ts` and `bash.test.ts` pin section order and
substance, the absence of product references, exact renderer formats, and the
Bash semantics sentence (including the absence of the permission-prompt
rationale). `host-free.test.ts` bans `native-host-memory` from core imports.

## Related

- [Native provider context composition](2026-11-25-native-context-composition.md)
  — the Memory Files row and `memorySnapshot` pricing; its no-memory premise
  is superseded by this note.
- [Native host-service ports](../architecture/2026-11-19-native-host-service-ports.md)
  — the port discipline this extends with the seventh (memory) port.
- [Design spec](../../../../docs/superpowers/specs/2026-11-27-native-memory-and-behavior-design.md).
- [CLI prompt extracts](../../../../docs/superpowers/specs/2026-11-27-cli-prompt-extracts.md)
  — the pinned CLI 2.1.311 reference texts.