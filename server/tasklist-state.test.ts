import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlPageCache } from './jsonl-cache.js'
import { deriveTaskListFromLines } from './tasklist-state.js'

function assistant(blocks: unknown[]): Record<string, unknown> {
  return { type: 'assistant', message: { content: blocks } }
}
function toolResult(toolUseId: string, text: string): Record<string, unknown> {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } }
}
function humanInput(text: string): Record<string, unknown> {
  return { type: 'user', message: { content: [{ type: 'text', text }] } }
}
const create = (id: string, subject: string) => ({ type: 'tool_use', id, name: 'TaskCreate', input: { subject } })
const update = (taskId: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: `u-${taskId}`, name: 'TaskUpdate', input: { taskId, ...input } })

describe('deriveTaskListFromLines (pure)', () => {
  it('derives subjects + rev from a create→result→update chain', () => {
    const lines = [
      humanInput('do it'),
      assistant([create('c1', 'Deploy service')]),
      toolResult('c1', 'Task #3 created successfully: Deploy service'),
      assistant([update('3', { status: 'in_progress' })]),
    ]
    const snap = deriveTaskListFromLines(lines)
    expect(snap.rev).toBe(2)
    expect(snap.tasks).toEqual([
      { id: '3', subject: 'Deploy service', status: 'in_progress', stale: false },
    ])
  })

  it('flags resolved tasks last touched BEFORE the last genuine user input as stale', () => {
    const lines = [
      humanInput('first request'),
      assistant([create('c1', 'old task')]),
      toolResult('c1', 'Task #1 created successfully: old task'),
      assistant([update('1', { status: 'completed' })]),
      humanInput('second request'), // boundary — after the completion
    ]
    const snap = deriveTaskListFromLines(lines)
    expect(snap.tasks[0]!.stale).toBe(true)
  })

  it('a task touched in the current turn (at/after the boundary) is NOT stale', () => {
    const lines = [
      humanInput('request'),
      assistant([create('c1', 'current')]),
      toolResult('c1', 'Task #1 created successfully: current'),
      assistant([update('1', { status: 'completed' })]),
    ]
    expect(deriveTaskListFromLines(lines).tasks[0]!.stale).toBe(false)
  })

  it('synthetic user frames do NOT move the boundary (task-notification / tool_result / sidechain)', () => {
    const notification = {
      type: 'user',
      message: { content: [{ type: 'text', text: '<task-notification>bg done</task-notification>' }] },
    }
    const lines = [
      humanInput('request'),
      assistant([create('c1', 't')]),
      toolResult('c1', 'Task #1 created successfully: t'),
      assistant([update('1', { status: 'completed' })]),
      // Any of these three judged genuine would move the boundary past the
      // completion and flip stale to true — so stale:false is what pins the
      // invariant. (The brief's original `.toBe(true)` asserted the opposite
      // of this test's name; see task-2-report.md deviations.)
      notification,
      toolResult('zzz', 'late tool result'),
      { type: 'user', parent_tool_use_id: 'side', message: { content: [{ type: 'text', text: 'sidechain' }] } },
    ]
    expect(deriveTaskListFromLines(lines).tasks[0]!.stale).toBe(false)
  })

  it('update-only transcript yields the server-side stub subject (create genuinely absent)', () => {
    const lines = [assistant([update('9', { status: 'in_progress' })])]
    const snap = deriveTaskListFromLines(lines)
    expect(snap.rev).toBe(1)
    expect(snap.tasks[0]).toEqual({ id: '9', subject: 'Task #9', status: 'in_progress', stale: false })
  })

  it('deleted tasks are absent; provisional creates (no result yet) are absent', () => {
    const lines = [
      assistant([create('c1', 'gone')]),
      toolResult('c1', 'Task #2 created successfully: gone'),
      assistant([update('2', { status: 'deleted' })]),
      assistant([create('c2', 'inflight')]), // result never lands
    ]
    expect(deriveTaskListFromLines(lines)).toEqual({ rev: 3, tasks: [] })
  })

  it('empty / eventless transcript → { rev: 0, tasks: [] }', () => {
    expect(deriveTaskListFromLines([])).toEqual({ rev: 0, tasks: [] })
    expect(deriveTaskListFromLines([assistant([{ type: 'text', text: 'hi' }])])).toEqual({ rev: 0, tasks: [] })
  })
})

describe('readAll via createJsonlPageCache (fixture files)', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tasklist-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const linesToText = (lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'

  function makeCache(path: string) {
    return createJsonlPageCache({
      locate: async (sid) => {
        if (sid !== 's1') return null
        const st = await stat(path)
        return { path, stat: { mtimeMs: st.mtimeMs, size: st.size } }
      },
      readFile: async (p) => readFile(p, 'utf8'),
    })
  }

  it('serves every complete line; a torn final line is excluded until complete', async () => {
    const lines = [assistant([create('c1', 'a')]), toolResult('c1', 'Task #1 created successfully: a')]
    const p = join(dir, 's1.jsonl')
    await writeFile(p, linesToText(lines) + '{"type":"user","message":{"content":[{"type":"te')
    const cache = makeCache(p)
    expect(await cache.readAll('s1')).toHaveLength(2) // torn line dropped
    await writeFile(p, linesToText(lines) + linesToText([humanInput('next')]))
    expect((await cache.readAll('s1')).length).toBe(3) // completed → included
  })

  it('returns [] when the transcript file does not exist', async () => {
    const cache = createJsonlPageCache({ locate: async () => null, readFile: async () => '' })
    expect(await cache.readAll('nope')).toEqual([])
  })
})
