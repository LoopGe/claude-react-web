// First-party `apptools` in-process MCP server (SDK createSdkMcpServer).
//
// Exposes the host's git tooling directly to the agent as `mcp__apptools__*`
// tools, reusing server/git.ts's high-level helpers (never raw runGit — not
// exported) so there is zero new shell path and the exact same
// validateRepoRelativePath / validateBranchName safety gates the GitPanel
// relies on. Writes are NOT pre-approved: they obey the session's permission
// flow like any other MCP tool.
//
// The built server binds the SESSION cwd in its handler closures and is
// injected into the session's mcpServers map at spawn and on every live
// setMcpServers (see SessionManager.injectAppTools). Build once per session
// and reuse — the server itself is stateless beyond cwd.

import { z } from 'zod'
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { FirstPartyToolServer } from './types.js'
import {
  getStatus,
  getLog,
  listBranches,
  listStashes,
  stageFiles,
  unstageFiles,
  discardTracked,
  discardUntracked,
  commitChanges,
  abortMerge,
  abortRebase,
  stashCreate,
  stashPop,
  stashDrop,
  createBranch,
  checkoutBranch,
  validateRepoRelativePath,
  validateBranchName,
} from '../git.js'

/** Server name — tool FQN is `mcp__apptools__{name}`. */
export const APP_TOOLS_SERVER_NAME = 'apptools'

/** Bare read-only tool names (registry FQN set prefixes these). */
export const APP_TOOLS_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'git_status',
  'git_branches',
  'git_stashes',
  'git_log',
])

/** Bare mutating tool names — tool_results for these trigger a git-status
 *  broadcast (worktree change detection). */
export const APP_TOOLS_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'git_stage',
  'git_unstage',
  'git_discard',
  'git_commit',
  'git_stash_create',
  'git_stash_pop',
  'git_stash_drop',
  'git_abort_merge',
  'git_abort_rebase',
  'git_branch_create',
  'git_checkout',
])

/** The git server registered into the first-party registry. */
export const gitAppTools: FirstPartyToolServer = {
  name: APP_TOOLS_SERVER_NAME,
  description: 'First-party git tools bound to the session cwd',
  defaultEnabled: true,
  requiresCwd: true,
  buildTools: (cwd) => buildAppToolsTools(cwd ?? ''),
  readOnlyToolNames: APP_TOOLS_READ_ONLY_TOOLS,
  mutatingToolNames: APP_TOOLS_MUTATING_TOOLS,
}

/** Clean `CallToolResult` for a successful call. */
function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

/** `CallToolResult` carrying an error message (surfaced to the model, not a
 *  thrown exception that could reject the MCP call / hang the turn). */
function err(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** Shorthand: run a git helper inside the session's try/catch so no handler
 *  can reject the MCP call — HttpError (bad path, conflict, non-repo) and
 *  plain errors both become an `isError:true` text result. */
async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn()
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}

const PATH_LIST = z.array(z.string()).describe('repo-relative paths (no "..", no absolute paths)')

/** The tool definitions for the apptools server, bound to the session cwd.
 *  Exported separately from the server builder so tests can assert the tool
 *  set / annotations and invoke handlers without owning an McpServer. */
export function buildAppToolsTools(cwd: string): SdkMcpToolDefinition<any>[] {
  const readOnly = { readOnlyHint: true }
  return [
    tool('git_status', 'Show git working-tree status (branch, staged/unstaged/untracked files).', {}, async () =>
      guard(async () => ok(JSON.stringify(await getStatus(cwd), null, 2))),
      { annotations: readOnly },
    ),
    tool('git_branches', 'List git branches, marking the current one.', {}, async () =>
      guard(async () => ok(JSON.stringify(await listBranches(cwd), null, 2))),
      { annotations: readOnly },
    ),
    tool('git_stashes', 'List git stashes (most recent first).', {}, async () =>
      guard(async () => ok(JSON.stringify(await listStashes(cwd), null, 2))),
      { annotations: readOnly },
    ),
    tool('git_log', 'Show recent commit history (up to 100 commits).', { limit: z.number().int().min(1).max(100).default(20).optional() }, async (a) =>
      guard(async () => ok(JSON.stringify(await getLog(cwd, a.limit ?? 20), null, 2))),
      { annotations: readOnly },
    ),
    tool('git_stage', 'Stage files into the index.', { paths: PATH_LIST }, async (a) =>
      guard(async () => {
        const safe = a.paths.map((p) => validateRepoRelativePath(p))
        await stageFiles(cwd, safe)
        return ok(`staged ${safe.length} file(s)`)
      }),
    ),
    tool('git_unstage', 'Unstage files from the index (keep working-tree changes).', { paths: PATH_LIST }, async (a) =>
      guard(async () => {
        const safe = a.paths.map((p) => validateRepoRelativePath(p))
        await unstageFiles(cwd, safe)
        return ok(`unstaged ${safe.length} file(s)`)
      }),
    ),
    tool('git_discard', 'Discard working-tree changes for the given files. Tracked files revert to their committed state; untracked files are deleted from disk.', { paths: PATH_LIST }, async (a) =>
      guard(async () => {
        const safe = a.paths.map((p) => validateRepoRelativePath(p))
        const status = await getStatus(cwd)
        if (!status.isRepo) return err('not a git repository')
        const untracked = new Set(status.untracked.map((f) => f.path))
        const tracked = safe.filter((p) => !untracked.has(p))
        const untrack = safe.filter((p) => untracked.has(p))
        if (tracked.length) await discardTracked(cwd, tracked)
        if (untrack.length) await discardUntracked(cwd, untrack)
        return ok(`discarded ${safe.length} file(s)`)
      }),
    ),
    tool('git_commit', 'Commit the staged changes with the given message (non-amend).', { message: z.string().describe('commit message') }, async (a) =>
      guard(async () => {
        await commitChanges(cwd, a.message, false)
        return ok('committed')
      }),
    ),
    tool('git_stash_create', 'Stash uncommitted changes (optionally with a message).', { message: z.string().optional() }, async (a) =>
      guard(async () => {
        await stashCreate(cwd, a.message)
        return ok('stashed')
      }),
    ),
    tool('git_stash_pop', 'Pop the most recent stash back into the working tree.', {}, async () =>
      guard(async () => {
        await stashPop(cwd, 0)
        return ok('popped')
      }),
    ),
    tool('git_stash_drop', 'Drop a stash by index (0 = most recent).', { index: z.number().int().min(0).default(0).optional() }, async (a) =>
      guard(async () => {
        await stashDrop(cwd, a.index ?? 0)
        return ok('dropped')
      }),
    ),
    tool('git_abort_merge', 'Abort an in-progress merge.', {}, async () =>
      guard(async () => {
        await abortMerge(cwd)
        return ok('merge aborted')
      }),
    ),
    tool('git_abort_rebase', 'Abort an in-progress rebase.', {}, async () =>
      guard(async () => {
        await abortRebase(cwd)
        return ok('rebase aborted')
      }),
    ),
    tool('git_branch_create', 'Create a new branch (does not switch to it).', { name: z.string().describe('branch name') }, async (a) =>
      guard(async () => {
        await validateBranchName(a.name)
        await createBranch(cwd, a.name, false)
        return ok(`created branch ${a.name}`)
      }),
    ),
    tool('git_checkout', 'Switch to an existing branch; with create:true, create it first (git checkout -b).', { branch: z.string().describe('branch name'), create: z.boolean().optional() }, async (a) =>
      guard(async () => {
        await validateBranchName(a.branch)
        if (a.create) {
          await createBranch(cwd, a.branch, true)
        } else {
          await checkoutBranch(cwd, a.branch, false)
        }
        return ok(`checked out ${a.branch}`)
      }),
    ),
  ]
}

/** Build the in-process apptools MCP server for a session. Handlers are bound
 *  to the session cwd. The returned config is NOT serializable (holds a live
 *  McpServer instance) and must never enter the JSON McpConfigStore. */
export function buildAppToolsServer(cwd: string): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: APP_TOOLS_SERVER_NAME,
    version: '1.0.0',
    tools: buildAppToolsTools(cwd),
  })
}