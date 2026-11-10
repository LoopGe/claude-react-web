// reader.test.ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeSessionLog, loadNativeSessionLogSync } from './log.js'
import { nativeHistoryCache } from './cache.js'
import { readNativeHistoryEntries, readNativeHistoryPage } from './reader.js'
import { historyFromEvents } from './replay.js'
import type { HistoryPage } from '../../../history-reader.js'

let dir: string
afterEach(async () => { if (dir) { nativeHistoryCache.invalidate('s1'); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } })
async function seedLog() {
  dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
  const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
  const push = (e: never) => log.append(e)
  push({ type: 'session/context', text: 'ctx' } as never)
  push({ type: 'user', uuid: 'u1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } } as never)
  push({ type: 'assistant', uuid: 'a1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } } as never)
  push({ type: 'user', uuid: 'u2', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: 'three' }] } } as never)
  await log.flush(); await log.close()
}

async function seedLogWithCompact() {
  dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
  const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
  const push = (e: never) => log.append(e)
  push({ type: 'session/context', text: 'CTX' } as never)
  push({ type: 'user', uuid: 'p1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'pre-compact' }] } } as never)
  push({ type: 'assistant', uuid: 'p2', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'pre-compact reply' }] } } as never)
  push({ type: 'session/compact', text: 'SUMMARY', context: 'CTX', uuid: 'c1', timestamp: '2026-11-09T00:00:02.000Z' } as never)
  push({ type: 'user', uuid: 'u3', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:03.000Z', message: { role: 'user', content: [{ type: 'text', text: 'post-compact' }] } } as never)
  push({ type: 'assistant', uuid: 'a3', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'post-compact reply' }] } } as never)
  await log.flush(); await log.close()
}

function pageText(page: HistoryPage): string {
  return JSON.stringify(page)
}

describe('native history reader', () => {
  it('pages newest-first with the shared window semantics', async () => {
    await seedLog()
    const page = await readNativeHistoryPage(dir, 's1', { limit: 2 })
    expect((page.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['a1', 'u2'])
    expect(page.totalCount).toBe(3)
    expect(page.startIndex).toBe(1)
    expect(page.hasMore).toBe(true)
    const older = await readNativeHistoryPage(dir, 's1', { before: page.startIndex, limit: 2 })
    expect((older.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['u1'])
  })
  it('hides the inherited prefix after afterUuid', async () => {
    await seedLog()
    const page = await readNativeHistoryPage(dir, 's1', { limit: 10, afterUuid: 'a1' })
    expect((page.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['u2'])
    expect(page.totalCount).toBe(1)
  })
  it('returns entries with normalized timestamps and tool_result parents', async () => {
    await seedLog()
    const entries = await readNativeHistoryEntries(dir, 's1')
    expect(entries.map((e) => (e.message as { uuid: string }).uuid)).toEqual(['u1', 'a1', 'u2'])
    expect((entries[0].message as { receivedAt?: number }).receivedAt).toBe(Date.parse('2026-11-09T00:00:00.000Z'))
  })
  it('pages and searches only after the last compact', async () => {
    await seedLogWithCompact()
    const page = await readNativeHistoryPage(dir, 's1', { limit: 10 })
    expect(pageText(page)).not.toContain('pre-compact')
    expect(pageText(page)).toContain('SUMMARY')
    expect(pageText(page)).toContain('post-compact')
    const entries = await readNativeHistoryEntries(dir, 's1')
    expect(JSON.stringify(entries)).not.toContain('pre-compact')
  })
  it('repairs an interrupted post-compact turn but not pre-compact tools', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
    const push = (e: never) => log.append(e)
    push({ type: 'assistant', uuid: 'a0', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'pre', name: 'Read', input: {} }] } } as never)
    push({ type: 'session/compact', text: 'SUMMARY', context: 'CTX', uuid: 'c1', timestamp: '2026-11-09T00:00:01.000Z' } as never)
    push({ type: 'assistant', uuid: 'a1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'post', name: 'Read', input: {} }] } } as never)
    await log.flush(); await log.close()

    const entries = await readNativeHistoryEntries(dir, 's1')
    expect(entries.filter((e) => (e.message as { type?: string }).type === 'assistant').map((e) => (e.message as { uuid: string }).uuid)).toEqual(['a1'])
    const toolResultIds = entries.flatMap((entry) => {
      const content = (entry.message as { message?: { content?: unknown } }).message?.content
      if (!Array.isArray(content)) return []
      return (content as Array<{ type?: string; tool_use_id?: string; is_error?: boolean }>)
        .filter((block) => block.type === 'tool_result' && block.is_error === true)
        .map((block) => block.tool_use_id)
    })
    expect(toolResultIds).toEqual(['post'])
  })
  it('floors at the last compact when several exist', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
    const push = (e: never) => log.append(e)
    push({ type: 'user', uuid: 'p1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'pre-compact' }] } } as never)
    push({ type: 'session/compact', text: 'FIRST SUMMARY', context: 'CTX', uuid: 'c1', timestamp: '2026-11-09T00:00:01.000Z' } as never)
    push({ type: 'user', uuid: 'm1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: 'middle' }] } } as never)
    push({ type: 'session/compact', text: 'SECOND SUMMARY', context: 'CTX', uuid: 'c2', timestamp: '2026-11-09T00:00:03.000Z' } as never)
    push({ type: 'user', uuid: 'u3', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:04.000Z', message: { role: 'user', content: [{ type: 'text', text: 'post-compact' }] } } as never)
    await log.flush(); await log.close()

    const page = await readNativeHistoryPage(dir, 's1', { limit: 10 })
    expect(pageText(page)).not.toContain('FIRST SUMMARY')
    expect(pageText(page)).not.toContain('middle')
    expect(pageText(page)).toContain('SECOND SUMMARY')
    expect(pageText(page)).toContain('post-compact')
    expect(JSON.stringify(await readNativeHistoryEntries(dir, 's1'))).not.toContain('FIRST SUMMARY')
  })
  it('keeps sidechain lines in pages with their parent, but not in entries/search', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
    const push = (e: never) => log.append(e)
    push({ type: 'session/context', text: 'ctx' } as never)
    push({ type: 'user', uuid: 'u1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'top prompt' }] } } as never)
    push({ type: 'assistant', uuid: 'side', session_id: 's1', parent_tool_use_id: 'agent1', timestamp: '2026-11-09T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'inner reply' }] } } as never)
    push({ type: 'user', uuid: 'side-result', session_id: 's1', parent_tool_use_id: 'agent1', timestamp: '2026-11-09T00:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'inner-tool', content: [{ type: 'text', text: 'inner result' }], is_error: false }] } } as never)
    await log.flush(); await log.close()

    const page = await readNativeHistoryPage(dir, 's1', { limit: 10 })
    const pageMessages = page.messages as Array<{ uuid: string; parent_tool_use_id: string | null }>
    const side = pageMessages.find((m) => m.uuid === 'side')
    expect(side?.parent_tool_use_id).toBe('agent1')
    expect(pageMessages.find((m) => m.uuid === 'side-result')?.parent_tool_use_id).toBe('agent1')

    // Search / the transcript seq backfill see top-level turns only.
    const entries = await readNativeHistoryEntries(dir, 's1')
    const entryUuids = entries.map((e) => (e.message as { uuid: string }).uuid)
    expect(entryUuids).toContain('u1')
    expect(entryUuids).not.toContain('side')
    expect(entryUuids).not.toContain('side-result')

    // The model history the session resumes from is top-level only too.
    const events = loadNativeSessionLogSync(dir, 's1')!.events
    const history = JSON.stringify(historyFromEvents(events))
    expect(history).toContain('top prompt')
    expect(history).not.toContain('inner reply')
    expect(history).not.toContain('inner result')
  })
  it('returns an empty page for a missing log', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    expect(await readNativeHistoryPage(dir, 'nope', { limit: 10 })).toEqual({ messages: [], totalCount: 0, startIndex: 0, hasMore: false })
    expect(await readNativeHistoryEntries(dir, 'nope')).toEqual([])
  })
  it('ignores a header whose cwd contains the compact event name', async () => {
    // The boundary scan pre-filters on the literal substring; a project
    // directory literally named `session/compact` must not make the header
    // look like an event (it has no seq and would throw).
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/work/session/compact', resume: false })
    log.append({ type: 'user', uuid: 'u1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } } as never)
    await log.flush(); await log.close()

    const page = await readNativeHistoryPage(dir, 's1', { limit: 10 })
    expect(pageText(page)).toContain('hello')
  })
})
