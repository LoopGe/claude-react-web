// server/providers/native/tools/worktree.ts
//
// EnterWorktree / ExitWorktree — the CLI's isolation pair, native edition.
//
// The tools own the MODEL contract (schema, validation, phrasing, the
// "already in a worktree" / "nothing to exit" refusals); the host owns git
// (`NativeWorktreePort`). The session owns the one piece of state: its
// working directory. Entering changes it for every following tool call in the
// same turn (`LoopDeps.cwd` is a live getter), and the client derives the
// isolated-worktree chip from the tool_use blocks alone — so the TOOL NAMES
// and the `name`/`path` input fields are a client contract, not cosmetics.
//
// Creation follows the CLI's layout: `<repo>/.claude/worktrees/<name>` on
// branch `worktree-<name>`. `path` adopts an existing worktree under that
// managed root instead. Exit `keep` leaves both on disk; `remove` deletes both
// and refuses when that would discard uncommitted files or unmerged commits
// unless `discard_changes: true` says so explicitly.
import { isAbsolute, resolve } from 'node:path'
import { ToolInputError, type ToolDef, type ToolOutcome } from './types.js'
import type { NativeWorktreePort } from '../ports.js'

export interface WorktreeSession {
  /** Where the session works NOW (the worktree when one is entered). */
  cwd(): string
  /** The launch directory the session returns to on exit. */
  mainCwd(): string
  active(): { path: string; branch: string | null } | null
  enter(entry: { path: string; branch: string | null }): void
  leave(): void
}

export interface WorktreeToolDeps {
  port: NativeWorktreePort
  session: WorktreeSession
}

/** The CLI's per-segment grammar: letters, digits, dots, underscores, dashes,
 *  `/` between segments, 64 chars total. */
const WORKTREE_NAME_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/
const MAX_WORKTREE_NAME = 64

export type EnterWorktreeInput = { name?: string; path?: string }
export type ExitWorktreeInput = { action?: 'keep' | 'remove'; discard_changes?: boolean }

const ENTER_DESCRIPTION =
  'Enter an isolated git worktree so your edits never touch the user\'s checkout. '
  + 'Default: create `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>` from the current HEAD '
  + '(`name` optional — a random one is generated). `path` instead switches into an existing worktree under '
  + '`.claude/worktrees/` of this repo. Every following file / shell tool runs inside the worktree until '
  + 'ExitWorktree. Call this BEFORE editing when you want isolation; if it fails, continue in place.'

const ENTER_GUIDANCE =
  'Use EnterWorktree before editing when the work should stay isolated from the user\'s checkout; '
  + 'ExitWorktree returns to the launch directory and either keeps or removes the worktree.'

const EXIT_GUIDANCE =
  'Use ExitWorktree to leave the worktree entered with EnterWorktree: action "keep" preserves it, '
  + '"remove" deletes it and refuses while uncommitted files or unmerged commits would be lost.'

const EXIT_DESCRIPTION =
  'Leave the worktree entered with EnterWorktree and return to the launch directory. '
  + '`action: "keep"` leaves the worktree directory and its branch on disk for later; '
  + '`action: "remove"` deletes both and REFUSES while the worktree holds uncommitted files or commits '
  + 'not in the launch checkout — pass `discard_changes: true` to accept that loss.'

function quote(text: string): string {
  return `“${text}”`
}

function randomWorktreeName(): string {
  return `wt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function branchSuffix(branch: string | null): string {
  return branch === null ? '' : ` on branch ${quote(branch)}`
}

export function createEnterWorktreeTool(deps: WorktreeToolDeps): ToolDef<EnterWorktreeInput> {
  return {
    name: 'EnterWorktree',
    description: ENTER_DESCRIPTION,
    guidance: ENTER_GUIDANCE,
    promptOrder: 210,
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for a NEW worktree (letters, digits, dots, underscores, dashes, `/` between segments; max 64). Omit for a generated name. Mutually exclusive with path.' },
        path: { type: 'string', description: 'Absolute (or cwd-relative) path of an EXISTING worktree to switch into instead of creating one. Must be a worktree this repo manages under `.claude/worktrees/`. Mutually exclusive with name.' },
      },
      required: [],
      additionalProperties: false,
    },
    validate: validateEnter,
    async run(input, _ctx): Promise<ToolOutcome> {
      const session = deps.session
      const active = session.active()
      const path = typeof input.path === 'string' ? input.path.trim() : undefined
      const name = typeof input.name === 'string' ? input.name.trim() : undefined
      if (path === undefined && active !== null) {
        return {
          text: `Already in a worktree session (${quote(active.path)}). Pass \`path\` to switch into another existing worktree, or use ExitWorktree to leave this one before creating a new worktree.`,
          isError: true,
        }
      }
      try {
        if (path !== undefined) {
          const abs = isAbsolute(path) ? path : resolve(session.cwd(), path)
          const adopted = await deps.port.adopt(session.cwd(), abs)
          session.enter(adopted)
          return {
            text: `${active === null ? 'Entered the worktree at' : 'Switched into the worktree at'} ${quote(adopted.path)}${branchSuffix(adopted.branch)}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
          }
        }
        const created = await deps.port.create(session.cwd(), name ?? randomWorktreeName())
        session.enter(created)
        return {
          text: `Created worktree at ${quote(created.path)} on branch ${quote(created.branch)}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
        }
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true }
      }
    },
  }
}

function validateEnter(input: EnterWorktreeInput): void {
  if (input.name === undefined && input.path === undefined) return
  if (input.name !== undefined && input.path !== undefined) {
    throw new ToolInputError('name and path are mutually exclusive')
  }
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw new ToolInputError('name must be a non-empty string')
    }
    if (!WORKTREE_NAME_RE.test(input.name.trim())) {
      throw new ToolInputError('name may contain only letters, digits, dots, underscores, dashes and `/` between segments')
    }
    // `..` fits the character class but would escape `.claude/worktrees`.
    if (input.name.trim().split('/').includes('..')) {
      throw new ToolInputError('name segments cannot be `..`')
    }
    if (input.name.trim().length > MAX_WORKTREE_NAME) {
      throw new ToolInputError(`name must be at most ${MAX_WORKTREE_NAME} characters`)
    }
  }
  if (input.path !== undefined && (typeof input.path !== 'string' || input.path.trim() === '')) {
    throw new ToolInputError('path must be a non-empty string')
  }
}

export function createExitWorktreeTool(deps: WorktreeToolDeps): ToolDef<ExitWorktreeInput> {
  return {
    name: 'ExitWorktree',
    description: EXIT_DESCRIPTION,
    guidance: EXIT_GUIDANCE,
    promptOrder: 215,
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['keep', 'remove'], description: '"keep" leaves the worktree and branch on disk; "remove" deletes both.' },
        discard_changes: { type: 'boolean', description: 'Required true when action is "remove" and the worktree has uncommitted files or unmerged commits. The tool refuses and lists them otherwise.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    validate: validateExit,
    async run(input): Promise<ToolOutcome> {
      const session = deps.session
      const active = session.active()
      if (active === null) {
        return { text: `Nothing to exit: the session is already working in its launch directory ${quote(session.mainCwd())}.`, isError: true }
      }
      if (input.action === 'keep') {
        session.leave()
        return {
          text: `Left the worktree at ${quote(active.path)}${branchSuffix(active.branch)}; the worktree and its branch were kept on disk. The session is now working in ${quote(session.mainCwd())}.`,
        }
      }
      if (input.action !== 'remove') {
        return { text: `action must be "keep" or "remove"`, isError: true }
      }
      try {
        const { dirtyFiles, unmergedCommits } = await deps.port.inspect(active.path, session.mainCwd())
        const dirty = dirtyFiles.length
        if ((dirty > 0 || unmergedCommits > 0) && input.discard_changes !== true) {
          const listed = dirtyFiles.slice(0, 10).join('\n')
          return {
            text: `Refusing to remove the worktree at ${quote(active.path)}: ${dirty} uncommitted file${dirty === 1 ? '' : 's'} and ${unmergedCommits} commit${unmergedCommits === 1 ? '' : 's'} not in the launch checkout would be lost.\n`
              + `${listed}${dirty > 10 ? `\n…and ${dirty - 10} more` : ''}\n`
              + 'Commit or stash the changes (or push the commits) first, then exit with action "remove" — or pass discard_changes: true to delete them anyway.',
            isError: true,
          }
        }
        await deps.port.remove(session.mainCwd(), active.path, active.branch, input.discard_changes === true)
        session.leave()
        const discarded = dirty > 0 || unmergedCommits > 0
          ? ` Discarded ${dirty} uncommitted file${dirty === 1 ? '' : 's'} and ${unmergedCommits} commit${unmergedCommits === 1 ? '' : 's'}.`
          : ''
        return {
          text: `Removed the worktree at ${quote(active.path)}${branchSuffix(active.branch)}.${discarded} The session is now working in ${quote(session.mainCwd())}.`,
        }
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true }
      }
    },
  }
}

function validateExit(input: ExitWorktreeInput): void {
  if (input.action !== 'keep' && input.action !== 'remove') {
    throw new ToolInputError('action must be "keep" or "remove"')
  }
  if (input.discard_changes !== undefined && typeof input.discard_changes !== 'boolean') {
    throw new ToolInputError('discard_changes must be a boolean')
  }
}
