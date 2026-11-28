// server/providers/native/tools/worktree.test.ts
//
// EnterWorktree/ExitWorktree own the MODEL contract (schema, validation,
// refusals, CLI phrasing); git lives behind NativeWorktreePort. The client
// derives its worktree chip from the tool_use blocks alone, so the tool names
// and the `name`/`path` input fields are pinned here as a client contract.
import { describe, expect, it } from 'vitest'
import type { NativeWorktreePort } from '../ports.js'
import {
  createEnterWorktreeTool,
  createExitWorktreeTool,
  type WorktreeSession,
} from './worktree.js'
import { ToolInputError, type ToolContext } from './types.js'

const ctx = (cwd = '/repo'): ToolContext => ({ cwd, signal: new AbortController().signal })

/** A recording fake: git never runs, but every call's arguments are pinned.
 *  Entries mirror `git worktree list` (branch null = detached). */
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

/** The session's cwd state, exactly what native-session maintains. */
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

describe('EnterWorktree / ExitWorktree schema', () => {
  it('pins the client contract: names and the name/path input fields', () => {
    const { port } = fakePort()
    const enter = createEnterWorktreeTool({ port, session: fakeSession().session })
    const exit = createExitWorktreeTool({ port, session: fakeSession().session })

    expect(enter).toMatchObject({ name: 'EnterWorktree', promptOrder: 210, guidance: expect.any(String) })
    expect(enter.schema).toMatchObject({
      type: 'object',
      required: [],
      additionalProperties: false,
      properties: { name: { type: 'string' }, path: { type: 'string' } },
    })
    expect(enter.readOnlyHint).toBeUndefined()
    expect(enter.backgroundable).toBeUndefined()

    expect(exit).toMatchObject({ name: 'ExitWorktree', promptOrder: 215 })
    expect(exit.schema).toMatchObject({
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['keep', 'remove'] },
        discard_changes: { type: 'boolean' },
      },
    })
    expect(exit.backgroundable).toBeUndefined()
  })
})

describe('EnterWorktree', () => {
  it('creates the managed worktree and answers in the CLI sentence', async () => {
    const { port, calls } = fakePort()
    const state = fakeSession()
    const tool = createEnterWorktreeTool({ port, session: state.session })

    const result = await tool.run({ name: 'p0-fixes' }, ctx())

    expect(calls).toEqual([{ method: 'create', args: ['/repo', 'p0-fixes'] }])
    expect(result).toEqual({
      text:
        'Created worktree at “/repo/.claude/worktrees/p0-fixes” on branch “worktree-p0-fixes”. '
        + 'The session is now working in the worktree. '
        + 'Use ExitWorktree to leave mid-session, or exit the session to be prompted.',
    })
    // The state change IS the feature: following tools read this as cwd.
    expect(state.active()).toEqual({ path: '/repo/.claude/worktrees/p0-fixes', branch: 'worktree-p0-fixes' })
    expect(state.session.cwd()).toBe('/repo/.claude/worktrees/p0-fixes')
  })

  it('generates a name when none is given', async () => {
    const { port, calls } = fakePort()
    const tool = createEnterWorktreeTool({ port, session: fakeSession().session })

    await tool.run({}, ctx())

    const name = calls[0]!.args[1] as string
    expect(calls[0]!.method).toBe('create')
    expect(name).toMatch(/^wt-.+/)
  })

  it('refuses a second worktree without path, in the CLI\'s own words', async () => {
    const { port, calls } = fakePort()
    const state = fakeSession()
    state.session.enter({ path: '/repo/.claude/worktrees/one', branch: 'worktree-one' })
    const tool = createEnterWorktreeTool({ port, session: state.session })

    const result = await tool.run({ name: 'two' }, ctx())

    expect(calls).toEqual([])
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Already in a worktree session (“/repo/.claude/worktrees/one”).')
    expect(result.text).toContain('Pass `path` to switch into another existing worktree')
    expect(result.text).toContain('use ExitWorktree to leave this one')
  })

  it('adopts an existing worktree by path, resolving it against the session cwd', async () => {
    const { port, calls } = fakePort()
    const state = fakeSession()
    const tool = createEnterWorktreeTool({ port, session: state.session })

    const result = await tool.run({ path: '.claude/worktrees/other' }, ctx())

    expect(calls).toEqual([{ method: 'adopt', args: ['/repo', '/repo/.claude/worktrees/other'] }])
    expect(result.text).toContain('Entered the worktree at “/repo/.claude/worktrees/other” on branch “worktree-adopted”.')
    expect(state.session.cwd()).toBe('/repo/.claude/worktrees/other')
  })

  it('switches from one worktree into another when path is given', async () => {
    const { port } = fakePort()
    const state = fakeSession()
    state.session.enter({ path: '/repo/.claude/worktrees/one', branch: 'worktree-one' })
    const tool = createEnterWorktreeTool({ port, session: state.session })

    const result = await tool.run({ path: '/repo/.claude/worktrees/two' }, ctx('/repo/.claude/worktrees/one'))

    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('Switched into the worktree at “/repo/.claude/worktrees/two”')
    expect(state.session.cwd()).toBe('/repo/.claude/worktrees/two')
  })

  it('turns port failures into soft results the model can re-plan from', async () => {
    const { port } = fakePort({
      async create() { throw new Error('a worktree already exists at /repo/.claude/worktrees/dup') },
    })
    const state = fakeSession()
    const tool = createEnterWorktreeTool({ port, session: state.session })

    const result = await tool.run({ name: 'dup' }, ctx())

    expect(result).toEqual({ text: 'a worktree already exists at /repo/.claude/worktrees/dup', isError: true })
    expect(state.active()).toBeNull()
  })

  it('rejects malformed input before any git runs', () => {
    const { port, calls } = fakePort()
    const tool = createEnterWorktreeTool({ port, session: fakeSession().session })

    expect(() => tool.validate!({ name: 'a', path: '/x' })).toThrow(ToolInputError)
    expect(() => tool.validate!({ name: 'bad name' })).toThrow('name may contain only letters')
    expect(() => tool.validate!({ name: 'nar/../escape' })).toThrow(ToolInputError)
    expect(() => tool.validate!({ name: 'a'.repeat(65) })).toThrow('at most 64 characters')
    expect(() => tool.validate!({ path: '   ' })).toThrow('path must be a non-empty string')
    expect(() => tool.validate!({ name: 'ok.name_1/x-y' })).not.toThrow()
    expect(calls).toEqual([])
  })
})

describe('ExitWorktree', () => {
  it('errors when there is nothing to exit', async () => {
    const { port, calls } = fakePort()
    const tool = createExitWorktreeTool({ port, session: fakeSession().session })

    const result = await tool.run({ action: 'keep' }, ctx())

    expect(calls).toEqual([])
    expect(result.isError).toBe(true)
    expect(result.text).toContain('already working in its launch directory “/repo”')
  })

  it('keeps the worktree on disk and returns to the launch directory', async () => {
    const { port, calls } = fakePort()
    const state = fakeSession()
    state.session.enter({ path: '/repo/.claude/worktrees/keep', branch: 'worktree-keep' })
    const tool = createExitWorktreeTool({ port, session: state.session })

    const result = await tool.run({ action: 'keep' }, ctx('/repo/.claude/worktrees/keep'))

    expect(calls).toEqual([])
    expect(result).toEqual({
      text:
        'Left the worktree at “/repo/.claude/worktrees/keep” on branch “worktree-keep”; '
        + 'the worktree and its branch were kept on disk. The session is now working in “/repo”.',
    })
    expect(state.active()).toBeNull()
  })

  it('refuses to remove while work would be lost, listing what it would discard', async () => {
    const { port } = fakePort({
      async inspect() {
        return {
          dirtyFiles: [' M server/a.ts', '?? notes.md', ' M server/b.ts', 'D  gone.ts', ' M c', ' M d', ' M e', ' M f', ' M g', ' M h', ' M i', ' M j'],
          unmergedCommits: 2,
        }
      },
    })
    const state = fakeSession()
    state.session.enter({ path: '/repo/.claude/worktrees/dirty', branch: 'worktree-dirty' })
    const tool = createExitWorktreeTool({ port, session: state.session })

    const result = await tool.run({ action: 'remove' }, ctx('/repo/.claude/worktrees/dirty'))

    expect(result.isError).toBe(true)
    expect(result.text).toContain('12 uncommitted files and 2 commits not in the launch checkout would be lost.')
    expect(result.text).toContain(' M server/a.ts')
    expect(result.text).toContain('…and 2 more')
    expect(result.text).toContain('discard_changes: true')
    expect(state.active()).not.toBeNull()
  })

  it('never calls the dirty check "refusing" for a single file (CLI plural rules)', async () => {
    const { port } = fakePort({ async inspect() { return { dirtyFiles: [' M a.ts'], unmergedCommits: 0 } } })
    const state = fakeSession()
    state.session.enter({ path: '/repo/.claude/worktrees/one', branch: 'worktree-one' })
    const tool = createExitWorktreeTool({ port, session: state.session })

    const result = await tool.run({ action: 'remove' }, ctx('/repo/.claude/worktrees/one'))

    expect(result.text).toContain('1 uncommitted file and 0 commits not in the launch checkout would be lost.')
    expect(result.text).not.toContain('files and')
  })

  it('removes a clean worktree without discarding anything', async () => {
    const { port, calls } = fakePort()
    const state = fakeSession()
    state.session.enter({ path: '/repo/.claude/worktrees/clean', branch: 'worktree-clean' })
    const tool = createExitWorktreeTool({ port, session: state.session })

    const result = await tool.run({ action: 'remove' }, ctx('/repo/.claude/worktrees/clean'))

    expect(calls).toEqual([
      { method: 'inspect', args: ['/repo/.claude/worktrees/clean', '/repo'] },
      { method: 'remove', args: ['/repo', '/repo/.claude/worktrees/clean', 'worktree-clean', false] },
    ])
    expect(result.text).toBe(
      'Removed the worktree at “/repo/.claude/worktrees/clean” on branch “worktree-clean”. '
      + 'The session is now working in “/repo”.',
    )
    expect(state.active()).toBeNull()
  })

  it('forces removal with discard_changes and reports what was thrown away', async () => {
    const { port, calls } = fakePort({
      async inspect() { return { dirtyFiles: [' M a.ts', ' M b.ts'], unmergedCommits: 1 } },
    })
    const state = fakeSession()
    state.session.enter({ path: '/repo/.claude/worktrees/dirty', branch: 'worktree-dirty' })
    const tool = createExitWorktreeTool({ port, session: state.session })

    const result = await tool.run({ action: 'remove', discard_changes: true }, ctx('/repo/.claude/worktrees/dirty'))

    expect(calls.at(-1)).toEqual({
      method: 'remove',
      args: ['/repo', '/repo/.claude/worktrees/dirty', 'worktree-dirty', true],
    })
    expect(result.text).toContain('Removed the worktree at “/repo/.claude/worktrees/dirty”')
    expect(result.text).toContain('Discarded 2 uncommitted files and 1 commit.')
    expect(state.active()).toBeNull()
  })

  it('resolves a branch-less resumed worktree through the port', async () => {
    const { port, calls } = fakePort()
    const state = fakeSession()
    state.session.enter({ path: '/repo/.claude/worktrees/resumed', branch: null })
    const tool = createExitWorktreeTool({ port, session: state.session })

    const result = await tool.run({ action: 'remove' }, ctx('/repo/.claude/worktrees/resumed'))

    // branch null: the port deletes the directory but never guesses a branch.
    expect(calls.at(-1)).toEqual({ method: 'remove', args: ['/repo', '/repo/.claude/worktrees/resumed', null, false] })
    expect(result.text).toContain('Removed the worktree at “/repo/.claude/worktrees/resumed”.')
    expect(result.text).not.toContain('on branch')
  })

  it('turns a port failure into a soft result and stays in the worktree', async () => {
    const { port } = fakePort({
      async remove() { throw new Error('fatal: working trees containing submodules cannot be moved') },
    })
    const state = fakeSession()
    state.session.enter({ path: '/repo/.claude/worktrees/broken', branch: null })
    const tool = createExitWorktreeTool({ port, session: state.session })

    const result = await tool.run({ action: 'remove' }, ctx('/repo/.claude/worktrees/broken'))

    expect(result).toEqual({
      text: 'fatal: working trees containing submodules cannot be moved',
      isError: true,
    })
    expect(state.active()).not.toBeNull()
  })

  it('rejects a malformed action or discard flag before any git runs', () => {
    const { port, calls } = fakePort()
    const tool = createExitWorktreeTool({ port, session: fakeSession().session })

    expect(() => tool.validate!({})).toThrow('action must be "keep" or "remove"')
    expect(() => tool.validate!({ action: 'delete' as never })).toThrow(ToolInputError)
    expect(() => tool.validate!({ action: 'remove', discard_changes: 1 as never })).toThrow(
      'discard_changes must be a boolean',
    )
    expect(calls).toEqual([])
  })
})
