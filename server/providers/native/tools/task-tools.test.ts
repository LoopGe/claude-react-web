// server/providers/native/tools/task-tools.test.ts
//
// TaskCreate/TaskUpdate are thin ToolDefs over the per-session NativeTaskStore.
// TaskCreate's result text carries the assigned #N id (the host fold parses it);
// TaskUpdate returns a JSON mutation report and fails SOFT (isError) on an
// unknown id, while malformed input throws ToolInputError like every tool.
// TaskGet/TaskList are read-only JSON projections over store.get/store.list.
import { describe, expect, it } from 'vitest'
import { NativeTaskStore, type TaskCreateInput } from '../task-store.js'
import { createTaskCreateTool } from './task-create.js'
import { createTaskGetTool, type TaskGetInput } from './task-get.js'
import { createTaskListTool } from './task-list.js'
import { createTaskUpdateTool, type TaskUpdateInput } from './task-update.js'
import { ToolInputError, type ToolContext } from './types.js'

const ctx = (): ToolContext => ({ cwd: process.cwd(), signal: new AbortController().signal })
function parse<T>(text: string): T {
  return JSON.parse(text) as T
}

interface UpdateReport {
  success: boolean
  taskId: string
  updatedFields: string[]
  statusChange?: { from: string; to: string }
  error?: string
}

interface GetReport {
  task: {
    id: string
    subject: string
    description: string
    status: string
    blocks: string[]
    blockedBy: string[]
  } | null
}

interface ListReport {
  tasks: Array<{ id: string; subject: string; status: string; owner?: string; blockedBy: string[] }>
}

describe('createTaskCreateTool', () => {
  it('creates a task and returns the #N result text', async () => {
    const store = new NativeTaskStore()
    const tool = createTaskCreateTool(store)
    expect(tool.name).toBe('TaskCreate')
    expect(tool.promptOrder).toBe(180)
    expect(tool.guidance).toBe('Create a structured task; the result carries its #N id.')
    const result = await tool.run({ subject: 'Deploy', description: 'Ship the release' }, ctx())
    expect(result.text).toMatch(/Task #1 created successfully: Deploy/)
    expect(result.isError).toBeUndefined()
    expect(store.get('1')).toMatchObject({ subject: 'Deploy', description: 'Ship the release', status: 'pending' })
  })

  it('passes activeForm and metadata into the record', async () => {
    const store = new NativeTaskStore()
    const tool = createTaskCreateTool(store)
    await tool.run({ subject: 'Deploy', description: 'd', activeForm: 'Deploying', metadata: { priority: 'high' } }, ctx())
    expect(store.get('1')).toMatchObject({ activeForm: 'Deploying', metadata: { priority: 'high' } })
  })

  it('throws ToolInputError on missing subject', async () => {
    const tool = createTaskCreateTool(new NativeTaskStore())
    await expect(tool.run({ description: 'd' } as TaskCreateInput, ctx())).rejects.toThrow(ToolInputError)
  })

  it('throws ToolInputError on empty subject or description', async () => {
    const tool = createTaskCreateTool(new NativeTaskStore())
    await expect(tool.run({ subject: '  ', description: 'd' }, ctx())).rejects.toThrow(ToolInputError)
    await expect(tool.run({ subject: 'Deploy', description: '' }, ctx())).rejects.toThrow(ToolInputError)
  })

  it('keeps state per session — two stores do not share tasks', async () => {
    const a = createTaskCreateTool(new NativeTaskStore())
    const b = createTaskCreateTool(new NativeTaskStore())
    await a.run({ subject: 'Only in A', description: 'd' }, ctx())
    const result = await b.run({ subject: 'Only in B', description: 'd' }, ctx())
    expect(result.text).toMatch(/Task #1 created successfully: Only in B/)
  })
})

describe('createTaskUpdateTool', () => {
  it('updates status and reports the statusChange', async () => {
    const store = new NativeTaskStore()
    store.create({ subject: 'Deploy', description: 'd' })
    const tool = createTaskUpdateTool(store)
    expect(tool.name).toBe('TaskUpdate')
    expect(tool.promptOrder).toBe(180)
    expect(tool.guidance).toBe("Update a task by its #N id; status 'deleted' removes it.")
    const result = await tool.run({ taskId: '1', status: 'completed' }, ctx())
    const out = parse<UpdateReport>(result.text)
    expect(out.success).toBe(true)
    expect(out.taskId).toBe('1')
    expect(out.updatedFields).toEqual(['status'])
    expect(out.statusChange).toEqual({ from: 'pending', to: 'completed' })
    expect(result.isError).toBeUndefined()
    expect(store.get('1')!.status).toBe('completed')
  })

  it('unknown id is a soft isError failure, not a throw', async () => {
    const tool = createTaskUpdateTool(new NativeTaskStore())
    const result = await tool.run({ taskId: '99', status: 'completed' }, ctx())
    expect(result.isError).toBe(true)
    const out = parse<UpdateReport>(result.text)
    expect(out.success).toBe(false)
    expect(out.taskId).toBe('99')
    expect(typeof out.error).toBe('string')
    expect(out.error!.length).toBeGreaterThan(0)
  })

  it('throws ToolInputError on missing taskId', async () => {
    const tool = createTaskUpdateTool(new NativeTaskStore())
    await expect(tool.run({ status: 'completed' } as TaskUpdateInput, ctx())).rejects.toThrow(ToolInputError)
  })

  it('throws ToolInputError on an invalid status', async () => {
    const store = new NativeTaskStore()
    store.create({ subject: 'A', description: 'd' })
    const tool = createTaskUpdateTool(store)
    await expect(tool.run({ taskId: '1', status: 'bogus' } as unknown as TaskUpdateInput, ctx())).rejects.toThrow(ToolInputError)
  })

  it('merges dependencies, owner and metadata through the patch', async () => {
    const store = new NativeTaskStore()
    store.create({ subject: 'A', description: 'd', metadata: { a: 1 } })
    store.create({ subject: 'B', description: 'd' })
    const tool = createTaskUpdateTool(store)
    const result = await tool.run(
      { taskId: '1', addBlocks: ['2'], addBlockedBy: ['2'], owner: 'agent-7', metadata: { b: 2, a: null } },
      ctx(),
    )
    expect(parse<UpdateReport>(result.text).success).toBe(true)
    expect(store.get('1')).toMatchObject({ blocks: ['2'], blockedBy: ['2'], owner: 'agent-7', metadata: { b: 2 } })
  })

  it("status 'deleted' removes the task", async () => {
    const store = new NativeTaskStore()
    store.create({ subject: 'A', description: 'd' })
    const tool = createTaskUpdateTool(store)
    const result = await tool.run({ taskId: '1', status: 'deleted' }, ctx())
    const out = parse<UpdateReport>(result.text)
    expect(out.success).toBe(true)
    expect(out.statusChange).toEqual({ from: 'pending', to: 'deleted' })
    expect(store.get('1')).toBeNull()
  })
})

describe('createTaskGetTool', () => {
  it('returns the record incl. blocks/blockedBy for an existing id', async () => {
    const store = new NativeTaskStore()
    store.create({ subject: 'A', description: 'Ship it', activeForm: 'Shipping', metadata: { p: 1 } })
    store.create({ subject: 'B', description: 'd' })
    store.update('1', { addBlocks: ['2'], addBlockedBy: ['2'], owner: 'agent-7', status: 'in_progress' })
    const tool = createTaskGetTool(store)
    expect(tool.name).toBe('TaskGet')
    expect(tool.promptOrder).toBe(180)
    expect(tool.guidance).toBe('Read one task by #N id.')
    expect(tool.readOnlyHint).toBe(true)
    expect(tool.backgroundable).toBeUndefined()
    const result = await tool.run({ taskId: '1' }, ctx())
    expect(result.isError).toBeUndefined()
    expect(parse<GetReport>(result.text).task).toEqual({
      id: '1',
      subject: 'A',
      description: 'Ship it',
      status: 'in_progress',
      blocks: ['2'],
      blockedBy: ['2'],
    })
  })

  it('unknown id returns {task:null} without isError', async () => {
    const tool = createTaskGetTool(new NativeTaskStore())
    const result = await tool.run({ taskId: '99' }, ctx())
    expect(result.isError).toBeUndefined()
    expect(parse<GetReport>(result.text)).toEqual({ task: null })
  })

  it('throws ToolInputError on missing or empty taskId', async () => {
    const tool = createTaskGetTool(new NativeTaskStore())
    await expect(tool.run({} as TaskGetInput, ctx())).rejects.toThrow(ToolInputError)
    await expect(tool.run({ taskId: '  ' }, ctx())).rejects.toThrow(ToolInputError)
  })
})

describe('createTaskListTool', () => {
  it('lists all records in creation order with owner/blockedBy', async () => {
    const store = new NativeTaskStore()
    store.create({ subject: 'A', description: 'd' })
    store.create({ subject: 'B', description: 'd' })
    store.create({ subject: 'C', description: 'd' })
    store.update('2', { owner: 'agent-7', addBlockedBy: ['1'] })
    store.update('3', { status: 'completed' })
    const tool = createTaskListTool(store)
    expect(tool.name).toBe('TaskList')
    expect(tool.promptOrder).toBe(180)
    expect(tool.guidance).toBe('List all tasks with status and dependencies.')
    expect(tool.readOnlyHint).toBe(true)
    expect(tool.backgroundable).toBeUndefined()
    expect(tool.schema).toEqual({ type: 'object', properties: {} })
    const result = await tool.run({}, ctx())
    expect(result.isError).toBeUndefined()
    expect(parse<ListReport>(result.text).tasks).toEqual([
      { id: '1', subject: 'A', status: 'pending', blockedBy: [] },
      { id: '2', subject: 'B', status: 'pending', owner: 'agent-7', blockedBy: ['1'] },
      { id: '3', subject: 'C', status: 'completed', blockedBy: [] },
    ])
  })

  it('deleted tasks drop out, remaining order is preserved', async () => {
    const store = new NativeTaskStore()
    store.create({ subject: 'A', description: 'd' })
    store.create({ subject: 'B', description: 'd' })
    store.create({ subject: 'C', description: 'd' })
    store.update('2', { status: 'deleted' })
    const tool = createTaskListTool(store)
    const result = await tool.run({}, ctx())
    expect(parse<ListReport>(result.text).tasks.map((t) => t.id)).toEqual(['1', '3'])
  })

  it('empty store returns {tasks:[]}', async () => {
    const tool = createTaskListTool(new NativeTaskStore())
    const result = await tool.run({}, ctx())
    expect(result.isError).toBeUndefined()
    expect(parse<ListReport>(result.text)).toEqual({ tasks: [] })
  })
})