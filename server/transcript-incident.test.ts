/**
 * Incident regression (spec §13, Review Focus 1): the two confirmed sessions
 * where restart back-fill displaced disk-only records to the seq tail. These
 * fixtures reproduce the SHAPE (redacted): a v1 sidecar whose live arrival order
 * differs from the provider log order, and a provider JSONL in the correct
 * order. Ordered reconcile must rebuild to provider order, idempotently, and
 * record finite-label metrics.
 *
 *   3a2f5b6b…: old assistant text + two distinct compact summaries at the tail.
 *   7e8b9627…: a monitor task_notification event at the tail.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionManager } from './session-manager.js'
import { SessionStore } from './persistence.js'
import { encodeCwd } from './subagent-watcher.js'
import { metrics } from './metrics.js'

const CWD = tmpdir()
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

const assistant = (uuid: string, id: string, text: string) => ({
  type: 'assistant',
  uuid,
  parent_tool_use_id: null,
  message: { id, role: 'assistant', content: [{ type: 'text', text }] },
})
const summary = (uuid: string, id: string, text: string) => ({
  type: 'user',
  uuid,
  parent_tool_use_id: null,
  isCompactSummary: true,
  message: { id, role: 'user', content: text },
})
const monitor = (uuid: string, toolUseId: string) => ({
  type: 'system',
  subtype: 'task_notification',
  uuid,
  parent_tool_use_id: null,
  tool_use_id: toolUseId,
  status: 'completed',
  summary: 'monitor event',
})

/** Write a v1 sidecar (displaced live order) + provider JSONL (correct order),
 *  then boot a manager over that state dir. */
async function setup(sidecarMsgs: object[], jsonlMsgs: object[]) {
  const dir = await mkdtemp(join(tmpdir(), 'crw-incident-'))
  const id = `incident-${randomUUID()}`
  await mkdir(join(dir, 'transcripts'), { recursive: true })
  const rows = sidecarMsgs.map((msg, seq) => ({
    seq,
    uuid: (msg as { uuid: string }).uuid,
    type: (msg as { type: string }).type,
    subtype: (msg as { subtype?: string }).subtype,
    msg,
  }))
  await writeFile(join(dir, 'transcripts', `${id}.ndjson`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const projDir = join(dir, 'projects', encodeCwd(CWD))
  await mkdir(projDir, { recursive: true })
  await writeFile(join(projDir, `${id}.jsonl`), jsonlMsgs.map((m) => JSON.stringify(m)).join('\n') + '\n')

  const prev = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  const store = new SessionStore({ stateDir: dir })
  await store.load()
  const sm = new SessionManager({ store })
  cleanups.push(async () => {
    process.env.CLAUDE_CONFIG_DIR = prev
    await sm.shutdown()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return { id, sm }
}

const uuids = (win: { messages: Array<{ msg: unknown }> }) =>
  win.messages.map((m) => (m.msg as { uuid?: string }).uuid)

describe('incident regression: displaced disk-only records rebuild to provider order', () => {
  it('3a2f shape: old assistant + two compact summaries displaced to the tail', async () => {
    const A = assistant('A', 'mA', 'No response requested.')
    const N = assistant('N', 'mN', 'newer turn')
    const R1 = summary('R1', 'mR1', 'first compact summary')
    const R2 = summary('R2', 'mR2', 'second compact summary')
    // Live arrival order put both summaries at the tail; provider order has them
    // between A and N.
    const { id, sm } = await setup([A, N, R1, R2], [A, R1, R2, N])

    const win = await sm.getTranscriptWindow(id)
    expect(uuids(win)).toEqual(['A', 'R1', 'R2', 'N'])
    expect(win.generation).toBeGreaterThan(0)
    // No duplicate uuids.
    expect(new Set(uuids(win)).size).toBe(4)

    // Idempotent: a second reconcile is an empty append (no generation bump).
    const gen = win.generation
    const again = await sm.getTranscriptWindow(id)
    expect(again.generation).toBe(gen)
    expect(uuids(again)).toEqual(['A', 'R1', 'R2', 'N'])
  })

  it('7e8b shape: a monitor task_notification displaced to the tail', async () => {
    const A = assistant('A', 'mA', 'before monitor')
    const N = assistant('N', 'mN', 'after monitor')
    const M = monitor('M', 'tu-monitor')
    const { id, sm } = await setup([A, N, M], [A, M, N])

    const win = await sm.getTranscriptWindow(id)
    expect(uuids(win)).toEqual(['A', 'M', 'N'])
    expect(win.generation).toBeGreaterThan(0)
  })

  it('tail-only append stays append-only (no generation bump)', async () => {
    const A = assistant('A', 'mA', 'first')
    const B = assistant('B', 'mB', 'second')
    const C = assistant('C', 'mC', 'third')
    // Sidecar already holds the provider prefix [A, B]; C is a pure tail addition.
    const { id, sm } = await setup([A, B], [A, B, C])
    const win = await sm.getTranscriptWindow(id)
    expect(uuids(win)).toEqual(['A', 'B', 'C'])
    expect(win.generation).toBe(0)
  })

  it('records finite-label reconcile metrics (no session id/uuid in labels)', async () => {
    metrics.reset()
    const A = assistant('A', 'mA', 'first')
    const N = assistant('N', 'mN', 'newer')
    const R = assistant('R', 'mR', 'displaced')
    const { id, sm } = await setup([A, N, R], [A, R, N])
    await sm.getTranscriptWindow(id)
    const snap = metrics.snapshot()
    const rebuildKey = Object.keys(snap.counters).find((k) => k.startsWith('transcript_reconcile_total') && k.includes('mode=rebuild') && k.includes('result=success'))
    expect(rebuildKey).toBeDefined()
    expect(snap.counters[rebuildKey!]).toBeGreaterThan(0)
    // No label leaks a session id or uuid.
    for (const key of Object.keys(snap.counters)) {
      expect(key).not.toContain(id)
      expect(key).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/)
    }
    const msKey = Object.keys(snap.histograms).find((k) => k.startsWith('transcript_rebuild_ms'))
    expect(msKey).toBeDefined()
  })
})
