# Agent Note: EnterWorktree / ExitWorktree in the native provider

Status: implemented

## Problem

The native provider had no isolation tools at all, while the CLI's
`EnterWorktree` / `ExitWorktree` are part of normal Claude Code use, and the
CLIENT already understood them: `src/session-store/normalize.ts`'s
`getActiveWorktree` folds assistant `tool_use` blocks by tool NAME plus
`input.name` / `input.path` into `ServerMirror.activeWorktree`, feeding the
ChatPanel worktree chip. So the tools existed in the UI's contract and were
simply never produced — a native session could not isolate its edits, and a
resumed CLI transcript with an active worktree had nothing to re-enter.

The structural difficulty is that the native session's cwd was a SPAWN-TIME
CONSTANT (`opts.cwd`), read in ~40 places (tool contexts, hooks, subagent
runs, skills, memory, log cwd). Worktree isolation is a mid-session `chdir`.

## Decision

- **A host port owns git; the tools own the model contract.**
  `NativeWorktreePort` (`list/create/adopt/inspect/remove`) is an OPTIONAL
  `NativeHostPorts` field (absent = the pair is not registered, the same rule
  media tools use when their port is missing). `native/tools/worktree.ts`
  therefore imports no host-domain module — `host-free.test.ts`'s boundary
  stays intact. `createWorktreePort()` in `native-host-adapters.ts` is the
  real implementation, reusing `server/git.ts` (`listWorktrees`,
  `createWorktree`, `removeWorktreeDir`, `pruneWorktrees`,
  `getGitCommonDir`, `branchExists`, `tryCaptureGitHead`) under
  `withRepoLock(commonDir)`, because worktree add/remove/prune race on the
  same lock.
- **CLI layout and phrasing, verified not guessed.**
  `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>`
  (`/` flattened to `-`), and the create acknowledgement is the CLI's own
  sentence, copied from a real transcript:
  `Created worktree at “…” on branch “…”. The session is now working in the
  worktree. Use ExitWorktree to leave mid-session, or exit the session to be
  prompted.` The "already in a worktree" refusal is the binary's string
  (`Already in a worktree session (…). Pass \`path\` to switch into another
  existing worktree, or use ExitWorktree …`). Curly quotes match the CLI.
- **The cwd is live, everywhere.** `LoopDeps.cwd` became
  `string | (() => string)` with one `liveCwd(deps)` helper at its four use
  sites (Stop / PreToolUse / PostToolUse hooks + the ToolContext), and
  `NativeSession.workingCwd` is `worktree?.path ?? opts.cwd`. The Agent
  tool's deps got a `get cwd()` getter for the same reason — a subagent
  dispatched AFTER enabling isolation must inherit the worktree. A test
  pins the SAME-TURN case: `EnterWorktree` then `Bash pwd` in one turn
  prints the worktree path.
- **Resume/fork re-enters the worktree the transcript claims.** The client
  chip and the session's actual cwd must never disagree, so restore folds
  model history — the CANONICAL `tool-call` blocks — for the last
  `EnterWorktree` not followed by `ExitWorktree`. Crucially, canonical
  arguments are a RAW JSON string (`ToolCallBlock.arguments`), so the read
  goes through `parseToolInput`; an earlier draft read `.input` (the wire
  shape), silently matched `{}`, and would have restored nothing. The
  restore runs as an async promise awaited at turn start (before any tool),
  resolving the managed path via `port.list(mainCwd)` rather than rebuilding
  it from `opts.cwd` (the repo root need not be the spawn cwd). If the
  directory is gone, nothing is restored — no invented state.
- **`path` adopts, bounded to the managed root.** `git worktree list` must
  already contain it AND it must live under `<toplevel>/.claude/worktrees/`;
  anything else is refused with the CLI's "switching is limited to worktrees
  Claude Code manages… spawn an Agent with cwd set to …" guidance instead of
  silently adopting an arbitrary directory.
- **`remove` refuses lossy deletes.** `inspect` reports `git status
  --porcelain` lines (≤50) and commits reachable from HEAD but not the launch
  checkout (`rev-list --count HEAD ^<mainHead>`); with either non-empty and
  no `discard_changes: true`, the tool lists up to 10 files (+ "…and N
  more") and refuses. Success reports the discarded counts. Branch deletion
  (`branch -D`) happens only inside the same repo lock, after the directory
  is gone.

## Known deviations from the CLI (explicit, not parity-by-claim)

1. **Base ref is the local HEAD, not `worktreeBranchFrom`'s `fresh`
   default (origin's default branch).** Offline-safe and keeps unpushed
   commits; the CLI's `'head'` setting is the equivalent mode.
2. **ExitWorktree's success sentences are modelled on the CLI's log lines**
   (`Removed linked worktree at:` / `; kept worktree at: `) because the tool
   result strings could not be recovered verbatim; they are not byte-equal
   to the CLI's.
3. **No tmux session** is created alongside the worktree (`tmuxSessionName`
   in the CLI's output stays unused).
4. **The `<env>` block / system prompt still name the launch directory.**
   It is frozen per session for prompt-cache reasons, the same tradeoff as
   the existing checkout freezing; the tools, hooks and subagents all use the
   live cwd.
5. **Host-side session cwd does not follow** (GitPanel / git snapshot
   repoGroup / session list keep the launch directory). The chip is derived
   from the transcript, so it stays correct.
6. **"Unmerged commits" is measured against the main checkout's current
   HEAD**, not a recorded base ref.
7. **A resumed worktree starts branch-less** (branch resolved lazily through
   the port on exit), because the branch is not part of the persisted
   tool_use input.
8. **First-entry multi-repo workspaces** (a launch dir nested in a bigger
   repo layout) are not modelled; the managed root always comes from
   `rev-parse --show-toplevel`.

## Alternatives considered

- **`process.chdir` + a mutable `opts.cwd`.** The CLI chdirs, but a process
  global would make concurrent sessions in one server share a directory.
  A live getter on the session is the same behaviour scoped correctly.
- **Fabricating the cwd only for tool contexts** (leaving hooks/subagents on
  the launch dir) — that is exactly the split-brain the CLI does not have.
- **Importing `server/git.ts` directly in the tool file.** It works locally
  but violates the core's structural host-free pin; a port is the supported
  seam.
- **Persisting the worktree as a `session/*` event type** instead of folding
  history. Durable and cheaper to restore, but it invents a second source of
  truth for something the transcript already carries and the client already
  folds; the model-history fold stays correct across forks for free.
- **`fresh` branch base (origin's default branch).** Rejected: requires a
  network fetch and silently drops local unpushed commits; `Head` is the
  offline-safe equivalent and is what the tools promise.

## Consequences

- Worktree isolation works for the whole session surface: file/shell tools,
  hooks, subagents, and same-turn follow-ups, with the ChatPanel chip
  (client-side, unchanged) telling the truth after a resume.
- Two extra tools appear in every native session the host runs (the port is
  always wired in production), so tool-list pins moved by two names.
- The architecture now has a "session cwd can change mid-turn" seam: any new
  code that reads `opts.cwd` for execution (rather than for identity/state
  paths) inherits the launch-directory bug. `workingCwd` is the only correct
  read; the log cwd, skills catalog, and memory roots deliberately stay at
  the launch directory (identity, not execution).
- A resumed session does an extra `git worktree list` before its first turn
  when the transcript claims isolation; one bounded spawn, not per-call.

## Verification

- `tools/worktree.test.ts`: 17 unit cases over a recording fake port —
  schema/client-contract pin, CLI create sentence, generated name, refusal
  in the CLI's words, adopt + relative-path resolution, switch-from-active,
  soft port errors, validation (`..` segments included), exit with nothing to
  exit, keep, dirty/unmerged refusal (+ plural rules), clean remove, forced
  remove with discard counts, branch-less resume, port failure keeps state.
- `native-worktree-port.test.ts`: 9 REAL-GIT cases in temp repos — managed
  layout + real checkout, nested names, existing-path refusal, occupied
  branch name, adopt boundary, dirty/unmerged inspection, clean remove +
  branch deletion, forced remove.
- `e2e-worktree.test.ts`: 3 session-level cases — same-turn `Bash pwd`
  inside the worktree, resume re-entry (the canonical-arguments bug above was
  found by this test), and `ExitWorktree keep` returning to the launch
  checkout while leaving the directory on disk.
- `native-session.test.ts` tool-list pins gained the two names;
  `native-host-adapters.test.ts` now pins ten ports.
- `tsc -p tsconfig.json` / `tsconfig.node.json` clean; eslint clean on the
  touched files; native suite green apart from two pre-existing environment
  flakes (`e2e-memory` dream, `e2e-subagent` 5s timeout under parallel load),
  both passing on a targeted single run.
