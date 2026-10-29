import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm, stat as realStat, readFile, readdir as realReaddir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlPageCache } from './jsonl-cache.js'
import {
  deriveTaskListFromLines,
  deriveTaskListForSession,
  createSubagentLineReader,
  mergeTranscriptLines,
  readSubagentTranscriptLines,
} from './tasklist-state.js'

function assistant(blocks: unknown[]): Record<string, unknown> {
  return { type: 'assistant', message: { content: blocks } }
}
function toolResult(toolUseId: string, text: string): Record<string, unknown> {
  return { type: 'user', message: { content: [toolResultBlock(toolUseId, text)] } }
}
function toolResultBlock(toolUseId: string, text: string): Record<string, unknown> {
  return { type: 'tool_result', tool_use_id: toolUseId, content: text }
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

  it('a DISK sidechain user line (isSidechain, no parent field) does NOT move the boundary either', () => {
    // Subagent-transcript disk lines carry isSidechain:true but NO
    // parent_tool_use_id — that field only exists on live wire frames. When
    // subagent lines are merged into the fold, their prompt lines must not
    // be mistaken for human input or the stale boundary jumps forward.
    const lines = [
      humanInput('request'),
      assistant([create('c1', 't')]),
      toolResult('c1', 'Task #1 created successfully: t'),
      assistant([update('1', { status: 'completed' })]),
      { type: 'user', isSidechain: true, message: { content: [{ type: 'text', text: 'You are implementing Task 1' }] } },
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
        const st = await realStat(path)
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

describe('mergeTranscriptLines (pure)', () => {
  it('orders main + subagent lines by timestamp', () => {
    const main = [
      { timestamp: '2026-01-01T00:00:01Z', k: 'm1' },
      { timestamp: '2026-01-01T00:00:03Z', k: 'm2' },
    ]
    const sub = [
      { timestamp: '2026-01-01T00:00:02Z', k: 's1' },
      { timestamp: '2026-01-01T00:00:04Z', k: 's2' },
    ]
    expect(mergeTranscriptLines(main, sub).map((l) => (l as { k: string }).k)).toEqual(['m1', 's1', 'm2', 's2'])
  })

  it('ties keep main before sub (stable sort over [main…, sub…])', () => {
    const main = [{ timestamp: '2026-01-01T00:00:01Z', k: 'm1' }]
    const sub = [{ timestamp: '2026-01-01T00:00:01Z', k: 's1' }]
    expect(mergeTranscriptLines(main, sub).map((l) => (l as { k: string }).k)).toEqual(['m1', 's1'])
  })

  it('merges NORMALIZED main frames (receivedAt epoch ms) with raw subagent lines (timestamp ISO) by instant', () => {
    // readAll serves normalize(o)-shaped frames — the ISO timestamp has
    // become receivedAt epoch ms — while subagent files are raw CLI lines.
    // The sort key must unify the two or every main line sorts first and
    // the interleaving (and with it the stale boundary) is garbage.
    const main = [
      {
        type: 'user',
        receivedAt: Date.parse('2026-01-01T00:00:03Z'),
        message: { content: [{ type: 'text', text: 'later human input' }] },
      },
    ]
    const sub = [
      { type: 'assistant', isSidechain: true, timestamp: '2026-01-01T00:00:01Z', message: { content: [update('1', { status: 'completed' })] } },
    ]
    // Subagent completion (00:01) sorts BEFORE the later human input (00:03)
    // — so through the fold it lands before the stale boundary → stale.
    const snap = deriveTaskListFromLines(mergeTranscriptLines(main, sub))
    expect(snap.tasks[0]).toMatchObject({ id: '1', status: 'completed', stale: true })
  })
})

describe('readSubagentTranscriptLines (fixture files)', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tasklist-sub-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('parses agent-*.jsonl files (sorted), drops the torn tail, ignores meta.json', async () => {
    const subDir = join(dir, 'sess', 'subagents')
    await mkdir(subDir, { recursive: true })
    await writeFile(join(subDir, 'agent-a.jsonl'), JSON.stringify({ type: 'assistant', timestamp: 't1', message: { content: [] } }) + '\n')
    await writeFile(join(subDir, 'agent-b.jsonl'),
      JSON.stringify({ type: 'user', timestamp: 't2', message: { content: [] } }) + '\n' +
      JSON.stringify({ type: 'assistant', timestamp: 't3', message: { content: [] } }) + '\n' +
      '{"type":"user","message":{"conte')
    await writeFile(join(subDir, 'agent-b.meta.json'), '{}')
    const lines = await readSubagentTranscriptLines(join(dir, 'sess.jsonl'), 'sess')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatchObject({ timestamp: 't1' })
    expect(lines[2]).toMatchObject({ timestamp: 't3' })
  })

  it('returns [] when the subagents dir does not exist (no sidechain work)', async () => {
    expect(await readSubagentTranscriptLines(join(dir, 'x.jsonl'), 'x')).toEqual([])
  })

  it('caches per file on (size, mtime): unchanged files skip readFile, grown files re-parse', async () => {
    const subDir = join(dir, 'sess', 'subagents')
    await mkdir(subDir, { recursive: true })
    const p = join(subDir, 'agent-a.jsonl')
    await writeFile(p, JSON.stringify({ type: 'assistant', timestamp: 't1', message: { content: [] } }) + '\n')
    const reads: string[] = []
    const reader = createSubagentLineReader({
      readdir: async (d) => (await realReaddir(d)).filter((n) => n.endsWith('.jsonl')),
      readFile: async (f) => { reads.push(f); return readFile(f, 'utf8') },
      stat: realStat,
    })
    const mainPath = join(dir, 'sess.jsonl')
    await reader(mainPath, 'sess')
    expect(reads).toHaveLength(1)
    await reader(mainPath, 'sess')
    expect(reads).toHaveLength(1) // unchanged → served from cache
    // The file must actually GROW (the cache's freshness key is (size,
    // mtimeMs) — a same-size rewrite leaves the read to mtime resolution
    // alone, which is not deterministic on Windows). Append-only, like the
    // JSONL the cache is designed for.
    await writeFile(p, [
      JSON.stringify({ type: 'assistant', timestamp: 't2', message: { content: [] } }),
      JSON.stringify({ type: 'assistant', timestamp: 't3', message: { content: [] } }),
    ].join('\n') + '\n')
    await reader(mainPath, 'sess')
    expect(reads).toHaveLength(2) // grown (size changed) → re-read
    expect((await reader(mainPath, 'sess'))[0]).toMatchObject({ timestamp: 't2' })
  })

  it('an unreadable subagent file is skipped (warn), the rest still fold', async () => {
    const subDir = join(dir, 'sess', 'subagents')
    await mkdir(subDir, { recursive: true })
    await writeFile(join(subDir, 'agent-ok.jsonl'), JSON.stringify({ type: 'assistant', timestamp: 't1', message: { content: [] } }) + '\n')
    // A DIRECTORY named like a transcript — readFile fails EISDIR, deterministic
    await mkdir(join(subDir, 'agent-bad.jsonl'))
    const lines = await readSubagentTranscriptLines(join(dir, 'sess.jsonl'), 'sess')
    expect(lines).toHaveLength(1)
  })
})

describe('deriveTaskListForSession degrades to main-only on subagent-read failure', () => {
  let cfgDir: string
  const prevEnv = process.env.CLAUDE_CONFIG_DIR
  beforeEach(async () => {
    cfgDir = await mkdtemp(join(tmpdir(), 'tasklist-e2e-'))
    process.env.CLAUDE_CONFIG_DIR = cfgDir
  })
  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevEnv
    await rm(cfgDir, { recursive: true, force: true })
  })

  it('a broken subagents dir does not wipe the main-transcript snapshot', async () => {
    const proj = join(cfgDir, 'projects', 'proj')
    await mkdir(proj, { recursive: true })
    const sid = '22222222-2222-4222-8222-222222222222'
    await writeFile(join(proj, `${sid}.jsonl`), [
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text: 'do it' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { content: [create('c1', 'A')] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:02Z', message: { content: [toolResultBlock('c1', 'Task #1 created successfully: A')] } }),
    ].join('\n') + '\n')
    // readdir on this path fails: a FILE where the subagents DIR belongs
    await writeFile(join(proj, sid), 'not a dir')

    const snap = await deriveTaskListForSession(sid)
    expect(snap.rev).toBe(1)
    expect(snap.tasks).toEqual([
      { id: '1', subject: 'A', status: 'pending', stale: false },
    ])
  })

  it('an unreadable MAIN transcript degrades fully (no subagent-only authoritative snapshot)', async () => {
    // readAll swallows read errors into [] — without the guard, the subagent
    // half would still fold and publish stub-subject tasks as authoritative.
    const proj = join(cfgDir, 'projects', 'proj')
    await mkdir(proj, { recursive: true })
    const sid = '33333333-3333-4333-8333-333333333333'
    const mainPath = join(proj, `${sid}.jsonl`)
    await writeFile(mainPath, [
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text: 'do it' }] } }),
    ].join('\n') + '\n')
    const subDir = join(proj, sid, 'subagents')
    await mkdir(subDir, { recursive: true })
    await writeFile(join(subDir, 'agent-a1.jsonl'),
      JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: '2026-01-01T00:00:01Z', message: { content: [update('1', { status: 'completed' })] } }) + '\n')
    // Make the main transcript unreadable PORTABLY: chmod(0o000) is advisory
    // on Windows (the owner can still read), so swap the file for a directory
    // at the same path — the read fails with EISDIR on every platform (the
    // same trick as the 'unreadable subagent file' case above).
    await rm(mainPath)
    await mkdir(mainPath)
    expect(await deriveTaskListForSession(sid)).toEqual({ rev: 0, tasks: [] })
  })
})

describe('subagent line cache byte budget', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tasklist-bytes-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('evicts oldest entries once the source-byte budget is exceeded (no unbounded heap pinning)', async () => {
    const subDir = join(dir, 'sess', 'subagents')
    await mkdir(subDir, { recursive: true })
    const line = JSON.stringify({ type: 'assistant', timestamp: 't', message: { content: [] } }) + '\n'
    await writeFile(join(subDir, 'agent-a.jsonl'), line)
    await writeFile(join(subDir, 'agent-b.jsonl'), line)
    const reads: string[] = []
    const reader = createSubagentLineReader({
      readdir: async (d) => (await realReaddir(d)).filter((n) => n.endsWith('.jsonl')),
      readFile: async (f) => { reads.push(f); return readFile(f, 'utf8') },
      stat: realStat,
    }, { maxBytes: line.length + 1 }) // holds ONE file
    const mainPath = join(dir, 'sess.jsonl')
    await reader(mainPath, 'sess')
    expect(reads).toHaveLength(2)
    await reader(mainPath, 'sess')
    // a-file was evicted when b-file landed (insertion order) → re-read once
    expect(reads).toHaveLength(3)
  })
})

describe('deriveTaskListForSession folds subagent transcripts (the bug)', () => {
  // Real layout under CLAUDE_CONFIG_DIR: projects/<proj>/<sid>.jsonl plus the
  // sibling <sid>/subagents/agent-*.jsonl the CLI 2.x writes subagent turns
  // into. Regression: a task completed by a SUBAGENT (its TaskUpdate lives
  // only in the subagent file) stayed in_progress forever in the snapshot.
  let cfgDir: string
  const prevEnv = process.env.CLAUDE_CONFIG_DIR
  beforeEach(async () => {
    cfgDir = await mkdtemp(join(tmpdir(), 'tasklist-e2e-'))
    process.env.CLAUDE_CONFIG_DIR = cfgDir
  })
  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevEnv
    await rm(cfgDir, { recursive: true, force: true })
  })

  const disk = (o: Record<string, unknown>, ts: string): string => JSON.stringify({ ...o, timestamp: ts }) + '\n'

  it('a task completed only inside a subagent transcript derives as completed', async () => {
    const proj = join(cfgDir, 'projects', 'proj')
    await mkdir(proj, { recursive: true })
    const sid = '11111111-1111-4111-8111-111111111111'
    const main = [
      disk({ type: 'user', message: { content: [{ type: 'text', text: 'do it' }] } }, '2026-01-01T00:00:00Z'),
      disk({ type: 'assistant', message: { content: [create('c1', 'A')] } }, '2026-01-01T00:00:01Z'),
      disk({ type: 'user', message: { content: [toolResultBlock('c1', 'Task #1 created successfully: A')] } }, '2026-01-01T00:00:02Z'),
      disk({ type: 'assistant', message: { content: [update('1', { status: 'in_progress' })] } }, '2026-01-01T00:00:03Z'),
    ]
    await writeFile(join(proj, `${sid}.jsonl`), main.join(''))
    // Subagent transcript: prompt line + the completed update that NEVER
    // touches the main file. The prompt line must not move the stale boundary.
    const subDir = join(proj, sid, 'subagents')
    await mkdir(subDir, { recursive: true })
    await writeFile(join(subDir, 'agent-a1.jsonl'),
      disk({ type: 'user', isSidechain: true, message: { content: 'You are implementing Task 1' } }, '2026-01-01T00:00:04Z') +
      disk({ type: 'assistant', isSidechain: true, message: { content: [update('1', { status: 'completed' })] } }, '2026-01-01T00:00:05Z'))

    const snap = await deriveTaskListForSession(sid)
    expect(snap.rev).toBe(3)
    expect(snap.tasks).toEqual([
      { id: '1', subject: 'A', status: 'completed', stale: false },
    ])
  })
})
