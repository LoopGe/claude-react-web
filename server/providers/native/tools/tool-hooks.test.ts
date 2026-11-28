// server/providers/native/tools/tool-hooks.test.ts
//
// TaskCreated / TaskCompleted / WorktreeCreate / WorktreeRemove are fired from
// INSIDE the tool implementations (the CLI's `zFr` / `DUt` / worktree call
// sites), not from the generic tool loop. These tests pin the tool-level
// contract: what the tool dispatches, what a block does to the world, and that
// WorktreeCreate's hook replaces creation.
import { describe, expect, it } from 'vitest'
import type { HookDecision, HookEvent } from '../../../../shared/hooks.js'
import { NativeTaskStore } from '../task-store.js'
import { createTaskCreateTool } from './task-create.js'
import { createTaskUpdateTool } from './task-update.js'
import { createEnterWorktreeTool, createExitWorktreeTool, type WorktreeSession } from './worktree.js'
import type { NativeWorktreePort } from '../ports.js'
import type { ToolContext } from './types.js'
import type { ToolHookPort } from './hook-port.js'

const ctx = (): ToolContext => ({ cwd: '/repo', signal: new AbortController().signal })

interface Dispatch {
  event: HookEvent
  fields: Record<string, unknown>
}

/** A hook port fake: `configured` is per-event and `decide` chooses the
 *  decision each dispatch returns (default: continue). */
function fakeHooks(opts: {
  configured?: HookEvent[]
  decide?: (event: HookEvent, fields: Record<string, unknown>) => HookDecision
} = {}) {
  const dispatches: Dispatch[] = []
  const port: ToolHookPort = {
    configured: (event) => (opts.configured ?? []).includes(event),
    async dispatch(event, fields) {
      dispatches.push({ event, fields })
      return opts.decide?.(event, fields) ?? { action: 'continue', additionalContext: [] }
    },
  }
  return { port, dispatches }
}

describe('TaskCreated / TaskCompleted', () => {
  it('TaskCreate dispatches with the assigned id and rolls back on a block', async () => {
    const store = new NativeTaskStore()
    const { port, dispatches } = fakeHooks({
      decide: () => ({ action: 'block', block: { reason: 'no tasks today', target: 'model' }, additionalContext: [] }),
    })
    const tool = createTaskCreateTool(store, port)
    const result = await tool.run({ subject: 'Deploy', description: 'Ship it' }, ctx())

    expect(dispatches).toEqual([{
      event: 'TaskCreated',
      fields: { task_id: '1', task_subject: 'Deploy', task_description: 'Ship it' },
    }])
    expect(result).toMatchObject({ isError: true })
    expect(result.text).toContain('no tasks today')
    expect(store.get('1')).toBeNull()
  })

  it('TaskCreate rolls back when the dispatch throws', async () => {
    const store = new NativeTaskStore()
    const port: ToolHookPort = {
      configured: () => true,
      async dispatch() { throw new Error('hook engine exploded') },
    }
    const tool = createTaskCreateTool(store, port)
    await expect(tool.run({ subject: 'Deploy', description: 'Ship it' }, ctx()))
      .rejects.toThrow('hook engine exploded')
    expect(store.get('1')).toBeNull()
  })

  it('TaskCreate keeps the record on continue', async () => {
    const store = new NativeTaskStore()
    const { port } = fakeHooks()
    const tool = createTaskCreateTool(store, port)
    const result = await tool.run({ subject: 'Deploy', description: 'Ship it' }, ctx())
    expect(result).toMatchObject({ text: 'Task #1 created successfully: Deploy' })
    expect(store.get('1')).toMatchObject({ subject: 'Deploy', status: 'pending' })
  })

  it('TaskCompleted fires only on the transition into completed, before the mutation', async () => {
    const store = new NativeTaskStore()
    const record = store.create({ subject: 'Deploy', description: 'Ship it' })
    const { port, dispatches } = fakeHooks({
      decide: () => ({ action: 'block', block: { reason: 'not yet', target: 'model' }, additionalContext: [] }),
    })
    const tool = createTaskUpdateTool(store, port)

    // A non-completing update does not dispatch.
    await tool.run({ taskId: record.id, status: 'in_progress' }, ctx())
    expect(dispatches).toEqual([])

    const blocked = await tool.run({ taskId: record.id, status: 'completed' }, ctx())
    expect(dispatches).toEqual([{
      event: 'TaskCompleted',
      fields: { task_id: record.id, task_subject: 'Deploy', task_description: 'Ship it' },
    }])
    expect(blocked).toMatchObject({ isError: true })
    expect(blocked.text).toContain('not yet')
    // The block left the task in its previous state.
    expect(store.get(record.id)?.status).toBe('in_progress')
  })

  it('TaskCompleted does not re-fire for an already-completed task', async () => {
    const store = new NativeTaskStore()
    const record = store.create({ subject: 'Deploy', description: 'Ship it' })
    store.update(record.id, { status: 'completed' })
    const { port, dispatches } = fakeHooks()
    const tool = createTaskUpdateTool(store, port)
    await tool.run({ taskId: record.id, status: 'completed' }, ctx())
    expect(dispatches).toEqual([])
  })
})

/** A recording fake port: no git, every call pinned. */
function fakePort(overrides: Partial<NativeWorktreePort> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const port: NativeWorktreePort = {
    async list(cwd) {
      calls.push({ method: 'list', args: [cwd] })
      return [{ path: '/repo', branch: 'main' }]
    },
    async create(cwd, name) {
      calls.push({ method: 'create', args: [cwd, name] })
      return { path: `/repo/.claude/worktrees/${name}`, branch: `worktree-${name}` }
    },
    async adopt(cwd, path) {
      calls.push({ method: 'adopt', args: [cwd, path] })
      return { path, branch: 'worktree-adopted' }
    },
    async inspect(worktreePath, mainCwd) {
      calls.push({ method: 'inspect', args: [worktreePath, mainCwd] })
      return { dirtyFiles: [], unmergedCommits: 0 }
    },
    async remove(mainCwd, worktreePath, branch, force) {
      calls.push({ method: 'remove', args: [mainCwd, worktreePath, branch, force] })
    },
    ...overrides,
  }
  return { port, calls }
}

function fakeSession() {
  let active: { path: string; branch: string | null } | null = null
  const session: WorktreeSession = {
    cwd: () => active?.path ?? '/repo',
    mainCwd: () => '/repo',
    active: () => active,
    enter: (entry) => { active = entry },
    leave: () => { active = null },
  }
  return { session, active: () => active }
}

describe('WorktreeCreate / WorktreeRemove', () => {
  it('a configured creator hook replaces git worktree creation', async () => {
    const { port, calls } = fakePort()
    const { session, active } = fakeSession()
    const { port: hooks, dispatches } = fakeHooks({
      configured: ['WorktreeCreate'],
      decide: (event) => event === 'WorktreeCreate'
        ? { action: 'continue', additionalContext: [], worktreePath: '/hooks/tree/wt' }
        : { action: 'continue', additionalContext: [] },
    })
    const tool = createEnterWorktreeTool({ port, session, hooks })
    const result = await tool.run({ name: 'wt' }, ctx())

    expect(calls.map((c) => c.method)).toEqual([])
    expect(dispatches).toEqual([{ event: 'WorktreeCreate', fields: { name: 'wt' } }])
    expect(active()).toEqual({ path: '/hooks/tree/wt', branch: null })
    expect(result.text).toContain('/hooks/tree/wt')
  })

  it('a creator hook that supplies no path fails instead of falling back', async () => {
    const { port, calls } = fakePort()
    const { session, active } = fakeSession()
    const { port: hooks } = fakeHooks({ configured: ['WorktreeCreate'] })
    const tool = createEnterWorktreeTool({ port, session, hooks })
    const result = await tool.run({ name: 'wt' }, ctx())

    expect(calls).toEqual([])
    expect(active()).toBeNull()
    expect(result).toMatchObject({ isError: true })
    expect(result.text).toContain('did not provide a worktree path')
  })

  it('a creator hook execution failure fails the entry', async () => {
    const { port, calls } = fakePort()
    const { session, active } = fakeSession()
    const { port: hooks } = fakeHooks({
      configured: ['WorktreeCreate'],
      decide: () => ({ action: 'continue', additionalContext: [], failure: 'mktree exploded' }),
    })
    const tool = createEnterWorktreeTool({ port, session, hooks })
    const result = await tool.run({ name: 'wt' }, ctx())

    expect(calls).toEqual([])
    expect(active()).toBeNull()
    expect(result).toMatchObject({ isError: true })
    expect(result.text).toContain('mktree exploded')
  })

  it('a blocking creator hook fails the entry', async () => {
    const { port, calls } = fakePort()
    const { session, active } = fakeSession()
    const { port: hooks } = fakeHooks({
      configured: ['WorktreeCreate'],
      decide: () => ({ action: 'block', block: { reason: 'policy', target: 'user' }, additionalContext: [] }),
    })
    const tool = createEnterWorktreeTool({ port, session, hooks })
    const result = await tool.run({ name: 'wt' }, ctx())

    expect(calls).toEqual([])
    expect(active()).toBeNull()
    expect(result).toMatchObject({ isError: true })
    expect(result.text).toContain('policy')
  })

  it('with no configured hook, creation runs through the port untouched', async () => {
    const { port, calls } = fakePort()
    const { session, active } = fakeSession()
    const { port: hooks, dispatches } = fakeHooks()
    const tool = createEnterWorktreeTool({ port, session, hooks })
    await tool.run({ name: 'wt' }, ctx())

    expect(calls).toEqual([{ method: 'create', args: ['/repo', 'wt'] }])
    expect(dispatches).toEqual([])
    expect(active()).toEqual({ path: '/repo/.claude/worktrees/wt', branch: 'worktree-wt' })
  })

  it('ExitWorktree remove dispatches WorktreeRemove and ignores its decision', async () => {
    const { port, calls } = fakePort()
    const { session } = fakeSession()
    session.enter({ path: '/repo/.claude/worktrees/wt', branch: 'worktree-wt' })
    const { port: hooks, dispatches } = fakeHooks({
      decide: () => ({ action: 'block', block: { reason: 'ignored', target: 'user' }, additionalContext: [] }),
    })
    const tool = createExitWorktreeTool({ port, session, hooks })
    const result = await tool.run({ action: 'remove' }, ctx())

    expect(dispatches).toEqual([{
      event: 'WorktreeRemove',
      fields: { worktree_path: '/repo/.claude/worktrees/wt' },
    }])
    expect(calls).toEqual([
      { method: 'inspect', args: ['/repo/.claude/worktrees/wt', '/repo'] },
      { method: 'remove', args: ['/repo', '/repo/.claude/worktrees/wt', 'worktree-wt', false] },
    ])
    expect(result.isError).toBeUndefined()
  })
})
