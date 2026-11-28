# Native provider: CLAUDE.md loading + behavior/tone guidance + environment context

Date: 2026-11-27
Status: implemented

## Intent and why

Native sessions today receive a minimal system prompt: one identity line plus
one-line-per-tool guidance (`server/providers/native/native-provider.ts`
`renderSystem`, `prompt/sections.ts`). Two concrete failures were reported
from real use in this repo:

1. **The model does not follow CLAUDE.md.** Root cause is structural, not
   behavioral: native loads no memory files at all (recorded in
   `.agents/notes/implemented/feature/2026-11-25-native-context-composition.md`),
   so the repo's rules never reach the model.
2. **Every Bash call is prefixed with `cd <cwd>`.** Native's Bash already
   spawns each command with `cwd: ctx.cwd` (`tools/bash.ts`), but nothing in
   the prompt tells the model where commands run: the tool description is
   "Run a shell command and return its output.", the guidance only mentions
   exit codes, and the cwd appears once in the opening
   `<system-reminder>` (`session-log/replay.ts` `contextSnapshot`). The model
   defensively re-`cd`s because it lacks the execution semantics.

The user also asked for the behavior/tone guidance gap from the
provider-prompt comparison to be closed (CLI has a full behavioral suite;
native has none).

Success looks like: a native session in this repo follows the same CLAUDE.md
rules as a claude session, stops prefixing `cd`, and communicates with the
same discipline (concise updates, outcome-first finals, no emoji, careful
actions).

## Goals

- Load the CLI's core memory source chain into native sessions:
  - User: `~/.claude/CLAUDE.md` (config dir via the existing
    `server/claude-config-dir.ts` `claudeConfigDir()`, which respects
    `CLAUDE_CONFIG_DIR`).
  - Project: walk from the session cwd up to the filesystem root; at each
    ancestor read `CLAUDE.md`, `.claude/CLAUDE.md`, and `CLAUDE.local.md`
    when present. Load order: user first, then ancestors root→cwd (the
    CLI's order, verified against the pinned CLI 2.1.311 binary).
  - **Worktree-aware resolution** (decided after the builder check): when
    the walk meets a directory whose `.git` is a worktree POINTER FILE
    (content `gitdir: <path>`), the physical ancestors above that worktree
    root are not the repo's ancestors. The reader parses the pointer (pure
    file read — no git subprocess), resolves the origin repo root from the
    gitdir path (`<origin>/.git/worktrees/<name>` → three dirnames up), and
    continues the chain from the origin root up to the filesystem root.
    Files are deduplicated by repo-relative path: the worktree's checked-out
    version wins (loaded first); the origin root's same-relative file is
    skipped, while its `CLAUDE.local.md` and above-root ancestors still
    load. This covers both manager-isolated worktrees
    (`<stateDir>/worktrees/<id>`, outside the repo) and in-repo worktrees
    (`.claude/worktrees/<name>`), with no double injection. Normal
    (non-worktree) sessions keep the literal full ancestor walk.
  - **Per-file source cap**: 1 MiB (DSH's `DEFAULT_MAX_SOURCE_BYTES`,
    adopted). A larger file is skipped and logged, never truncated into
    the prompt.
- Port the CLI's core behavior/tone sections as native prompt sections
  (adapted text, see below).
- Add an environment section (cwd, is-git-repo, platform, date) and rewrite
  the Bash description/guidance so the execution semantics are explicit.
- Keep the neutral-core architecture intact: file reading is host-side;
  the core receives text through a port.

## Non-goals (decided in conversation or by the author)

- **No `@path` import expansion, no `.claude/rules/` loading** — the user
  confirmed they use neither today. The reader's shape should leave room
  to add them later (per-file entries, not one concatenated blob), but no
  import/rules code is built now.
- No managed enterprise policy memory, no auto-memory, no AGENTS.md, no
  additional-working-directories memory (CLI has them; local single-user
  usage here does not).
- No security-policy / URL-guessing section and no Claude Code product
  identity — native keeps its own identity line.
- No file watcher: memory freshness is an mtime check at turn boundaries.
- No per-command permission mechanism for `cd` compounds (the CLI's
  stated reason for its git anti-pattern does not exist in native; the
  adapted guidance must give native's real reason instead).

## Anti-goals

- Breaking the neutrality pins (`native/vocabulary/neutrality.test.ts`,
  `native/host-free.test.ts`): core production files must not import host
  modules or SDK types; the new port interface crosses only neutral shapes.
- Making the stable part of the system prompt churn per turn (prompt-cache
  prefix stability). Dynamic facts (memory, environment, persona, skills,
  plan) append AFTER the stable base.
- Guidance with fake reasons or blunt prohibitions where a factual
  statement of semantics is the actual fix (the `cd` problem).
- Silently swallowing memory read errors: a missing file is an expected
  state (skip); any other read failure is logged (`createLogger`) and the
  file skipped — the session must not die on an unreadable memory file,
  but the failure must be visible.

## Constraints

- Neutral core speaks only vocabulary + shared + Node builtins + sibling
  vocabulary; host services enter through `NativeHostPorts`
  (`server/providers/native/ports.ts`, currently six ports, implementations
  in `server/providers/native-host-adapters.ts`).
- `renderSystem` builds the base prompt once per session (P1: no hot-plug);
  per-turn overlays are assembled in `native-session.ts` (`turnSystem` at
  ~line 2402: persona + `<available_skills>`; plan guidance appended per
  round from the live mode at ~line 2425).
- The opening `contextSnapshot` user-message reminder stays unchanged
  (fresh/resume/fork share it; it is part of the log/replay contract).
- Both providers keep receiving the same `FILE_REFERENCE_GUIDANCE` /
  Side-Chat texts from the manager — untouched by this change.
- The Context tab composition table (`getContextUsage`,
  `native-session.ts` ~3147) currently omits memory categories because
  native loads none; that premise changes here.

## Decisions made in conversation (the user's)

1. Loading scope aligns with the CLI's core chain: user-global AND project
   (both are in active use). Source list as in Goals.
2. `@import` / `.claude/rules/` are out of scope for this change (not used
   today).
3. The Bash fix follows the CLI's three-layer approach, not a blunt "don't
   cd" rule (extracted from the pinned CLI binary):
   - factual execution semantics in the tool description,
   - positive strategy (maintain cwd via absolute paths; `cd` only when the
     user explicitly asks),
   - the concrete high-frequency anti-pattern named with a REAL reason.
4. Worktree memory resolution is **repo-aware** (option A), not DSH's
   boundary-truncated walk and not the literal walk. DSH
   (`deepseek-harness/packages/context/agent-instructions`) stops at the
   first `.git` marker, so a worktree loads only its own checkout — it
   accepts the gitignored-local/ancestor gap. This repo actively uses
   worktrees, so the reader resolves the origin repo via the `.git` pointer
   file instead (mechanics in Goals). The pointer-file parse replaces a git
   subprocess: the origin path is literally in the file.
5. The DSH per-file 1 MiB source cap is adopted (skip + log over-cap files).
   DSH's per-chain byte budget and AGENTS.md candidates are NOT adopted
   (CLI has no chain budget; native loads CLAUDE.md only).

## Author's calls (builder may refine wording, not substance)

### Memory injection mechanism

System-prompt section, NOT a CLI-style system-reminder user message.
Rationale: native's system prompt is already session-stable; memory changes
rarely; a section keeps the message history clean and the cache prefix
stable. Freshness: the host reader caches per (path, mtimeMs, size); the
core re-requests memory when assembling each turn's system prompt, so an
edited CLAUDE.md takes effect on the next turn without a respawn.

### New port (seventh)

`NativeMemoryPort` in `ports.ts`:

```ts
export interface NativeMemoryFile {
  path: string        // absolute, for the section label
  scope: 'user' | 'project' | 'local'
  content: string
}
export interface NativeMemoryPort {
  read(cwd: string): Promise<NativeMemoryFile[]>
}
```

Host implementation: a new host-side module (suggested
`server/providers/native-host-memory.ts`) wired in
`native-host-adapters.ts`. It owns the ancestor walk, the worktree
pointer-file resolution and repo-relative dedup, `claudeConfigDir()`,
the per-file cap, the mtime cache, and the skip/log policy. The core never
touches `fs` for memory. The port stays `read(cwd)` — worktree resolution
is entirely host-side, so the neutral core needs no git/worktree concept.

### Prompt layout

Stable base (built once per session by `renderSystem`):

```
identity (order 0)                      — unchanged
behavior sections (orders ~10–70)       — NEW prompt/behavior.ts
tool guidance (orders 80–205)           — unchanged, except Bash text
systemPromptAppend (@ guidance / side chat) — unchanged
```

Per-turn overlay (assembled where `turnSystem` is built today), in order:

```
base + persona instruction + memory section + environment section + <available_skills>
```

Plan guidance stays per-round, appended last, unchanged.

- **Memory section**: one block per file, labeled with its absolute path and
  scope (e.g. `Contents of <path> (project instructions):`), files in load
  order. Empty chain → no section, no stray blank line (same discipline as
  `withSkillsSection`).
- **Environment section**: cwd, is-git-repo, platform, current date.
  The git probe result is cached per session at spawn (one `runGit`-style
  probe; host-side fact passed in or probed via an existing host capability
  — builder picks the cleanest seam that keeps the core host-free); date is
  rendered per turn. No git status/branch dump (that is the GitPanel's job,
  not the prompt's).
- **Subagents**: inherit the same overlay (memory + environment included)
  via the existing `subagentSystem` path; the Agent-section omission stays
  as today. Side chats load memory identically (same cwd).

### Behavior sections to port

New `server/providers/native/prompt/behavior.ts`, adapted from the pinned
CLI's texts (extracted and verified). Adaptation rule: strip Claude Code
product references and CLI-only mechanics; keep the behavioral substance;
never invent reasons. Sections (suggested names/orders):

| Section | CLI source | Substance |
|---|---|---|
| Communicating with the user | `# Communicating with the user` | user sees only text output; brief pre-tool sentence; outcome-first final |
| Tone and style | `# Tone and style` | concise; no emoji unless asked; `file_path:line_number` references; no colon before tool calls |
| Doing tasks | `# Doing tasks` | no scope creep / premature abstraction; no speculative error handling; finish fully; understand before fixing |
| Executing actions with care | `# Executing actions with care` | reversibility/blast-radius; confirm risky actions; authorization is scope-bound |
| Delivering work | `# Delivering work` | deliver the requested scope; assumptions over blocking questions; reaffirmed request = decision |
| Corrections | `# Corrections` | correct only what changes user decisions; no rumination |
| Pronouns | pronouns section | they/them when unstated; never infer from names |

These are generic agent behavior, not product identity — they apply to
native's own identity unchanged. Exact adapted wording is the builder's;
the substance table is the contract.

### Bash rewrite

`tools/bash.ts`:

- Description: "Run a shell command and return its output. Every call starts
  in the session working directory; a `cd` does not carry over to the next
  call, and shell state (env vars, functions) does not persist." (Native's
  true semantics: fresh `shell -c` per call, fixed cwd.)
- Guidance section keeps the exit-code sentence and adds the CLI's positive
  strategy adapted: maintain the working directory via absolute paths; `cd`
  only on explicit user request; never prepend `cd <working-directory>` to a
  command (git commands especially) — it already runs there, the prefix is
  redundant. No permission-prompt rationale (native has no such mechanism).

### Context-usage composition

`getContextUsage` gains a **Memory Files** used-row (the CLI's display
name), priced with the same `estimateText` density rule as the system
prompt. The environment section is priced inside the System prompt row
(it is part of the per-turn system string). Update
`.agents/notes/implemented/feature/2026-11-25-native-context-composition.md`
in the same change (its "native loads no memory files" premise is superseded).

## Verification

- Reader unit tests with tmpdir fixtures: ancestor chain order, user file,
  `.claude/CLAUDE.md` variant, `CLAUDE.local.md`, missing files skipped,
  unreadable file logged+skipped, over-cap file skipped+logged, mtime cache
  invalidation; worktree fixtures for BOTH layouts (in-repo
  `.claude/worktrees/<name>` and out-of-repo isolated): pointer parse,
  origin-chain continuation, repo-relative dedup (worktree version wins),
  `CLAUDE.local.md` recovered from the origin root, no double injection.
- Prompt assembly tests: behavior sections present and ordered; memory +
  environment overlay order; empty memory → no section; subagent inherits;
  plan guidance still per-round.
- Bash description/guidance pin (the semantics sentence is the contract).
- Neutrality + host-free pins extended to the new port/module boundary.
- Context composition test: Memory Files row sums into the used total.
- Existing native e2e suite stays green; add a memory-injection e2e case if
  the harness supports it cheaply (builder's call).

## Agent notes

New decision record
`.agents/notes/implemented/feature/2026-11-27-native-memory-and-behavior.md`
written with the implementation; update the context-composition note as
above.

## Left to the builder

- Exact adapted wording of the behavior sections and the Bash text.
- Order numbers within the suggested bands; section naming.
- Port method/cache implementation details; the git-probe seam for the
  environment section (must keep the core host-free).
- Whether the environment section's git fact is probed host-side at spawn
  and passed in, or read through an existing port.
- Test file layout and fixture style, matching repo conventions.