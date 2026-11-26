// reader.test.ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeSessionLog, loadNativeSessionLogSync } from './log.js'
import { nativeHistoryCache } from './cache.js'
import { readNativeHistoryEntries, readNativeHistoryPage, readNativeHistorySnapshot } from './reader.js'
import { historyFromEvents } from './replay.js'
import { migrateEventToV3 } from './migration.js'
import { isSidechainEvent, projectNeutralEventToLegacy } from './format.js'
import { makeNativePorts } from '../../native-host-adapters.js'
import { isRenderableSdkMessage, type HistoryPage, type RawLine } from '../../../../shared/transcript-format.js'
import type { NativeSessionEvent } from '../vocabulary/session-event.js'

const transcriptPort = makeNativePorts().transcript

/** The canonical neutral events of a loaded log (v3 baseline, or the lossless
 *  in-memory migration of a legacy view). */
function neutralEventsOf(snapshot: { neutralEvents?: NativeSessionEvent[]; events: Parameters<typeof migrateEventToV3>[0][] }): NativeSessionEvent[] {
  return snapshot.neutralEvents ?? snapshot.events.map(migrateEventToV3)
}

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
    const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 2 })
    expect((page.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['a1', 'u2'])
    expect(page.totalCount).toBe(3)
    expect(page.startIndex).toBe(1)
    expect(page.hasMore).toBe(true)
    const older = await readNativeHistoryPage(dir, 's1', transcriptPort, { before: page.startIndex, limit: 2 })
    expect((older.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['u1'])
  })
  it('hides the inherited prefix after afterUuid', async () => {
    await seedLog()
    const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 10, afterUuid: 'a1' })
    expect((page.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['u2'])
    expect(page.totalCount).toBe(1)
  })
  it('returns entries with normalized timestamps and tool_result parents', async () => {
    await seedLog()
    const entries = await readNativeHistoryEntries(dir, 's1', transcriptPort)
    expect(entries.map((e) => (e.message as { uuid: string }).uuid)).toEqual(['u1', 'a1', 'u2'])
    expect((entries[0].message as { receivedAt?: number }).receivedAt).toBe(Date.parse('2026-11-09T00:00:00.000Z'))
  })
  it('pages and searches only after the last compact', async () => {
    await seedLogWithCompact()
    const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 10 })
    expect(pageText(page)).not.toContain('pre-compact')
    expect(pageText(page)).toContain('SUMMARY')
    expect(pageText(page)).toContain('post-compact')
    const entries = await readNativeHistoryEntries(dir, 's1', transcriptPort)
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

    const entries = await readNativeHistoryEntries(dir, 's1', transcriptPort)
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

    const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 10 })
    expect(pageText(page)).not.toContain('FIRST SUMMARY')
    expect(pageText(page)).not.toContain('middle')
    expect(pageText(page)).toContain('SECOND SUMMARY')
    expect(pageText(page)).toContain('post-compact')
    expect(JSON.stringify(await readNativeHistoryEntries(dir, 's1', transcriptPort))).not.toContain('FIRST SUMMARY')
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

    const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 10 })
    const pageMessages = page.messages as Array<{ uuid: string; parent_tool_use_id: string | null }>
    const side = pageMessages.find((m) => m.uuid === 'side')
    expect(side?.parent_tool_use_id).toBe('agent1')
    expect(pageMessages.find((m) => m.uuid === 'side-result')?.parent_tool_use_id).toBe('agent1')

    // Search / the transcript seq backfill see top-level turns only.
    const entries = await readNativeHistoryEntries(dir, 's1', transcriptPort)
    const entryUuids = entries.map((e) => (e.message as { uuid: string }).uuid)
    expect(entryUuids).toContain('u1')
    expect(entryUuids).not.toContain('side')
    expect(entryUuids).not.toContain('side-result')

    // The model history the session resumes from is top-level only too.
    const snapshot = loadNativeSessionLogSync(dir, 's1')!
    const history = JSON.stringify(historyFromEvents(neutralEventsOf(snapshot)))
    expect(history).toContain('top prompt')
    expect(history).not.toContain('inner reply')
    expect(history).not.toContain('inner result')
  })
  it('keeps page-stream indices in entries so a search hit addresses the right page row', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
    const push = (e: never) => log.append(e)
    push({ type: 'session/context', text: 'ctx' } as never)
    push({ type: 'user', uuid: 'u1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'before' }] } } as never)
    push({ type: 'assistant', uuid: 'side', session_id: 's1', parent_tool_use_id: 'agent1', timestamp: '2026-11-09T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'inner' }] } } as never)
    push({ type: 'user', uuid: 'u2', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: 'after' }] } } as never)
    await log.flush(); await log.close()

    const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 10 })
    const pageUuids = (page.messages as Array<{ uuid: string }>).map((m) => m.uuid)
    // The page's messageIndex space includes the sidechain row.
    expect(pageUuids).toEqual(['u1', 'side', 'u2'])
    const pageIndexAfter = page.startIndex + pageUuids.indexOf('u2')

    // Entries drop the sidechain row but keep the remaining indices in the
    // SAME space, so history_read_context's messageIndex still lands on u2.
    const entries = await readNativeHistoryEntries(dir, 's1', transcriptPort)
    expect(entries.map((e) => (e.message as { uuid: string }).uuid)).toEqual(['u1', 'u2'])
    expect(entries.map((e) => e.index)).toEqual([0, 2])
    expect(entries[1].index).toBe(pageIndexAfter)
  })
  it('keeps skill instructions out of pages, search entries and seq backfill while replaying their bodies', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
    const push = (e: never) => log.append(e)
    push({ type: 'session/context', text: 'ctx' } as never)
    push({ type: 'user', uuid: 'u1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '/alpha args' }] } } as never)
    push({ type: 'session/skill', name: 'alpha', body: 'PERSISTED SKILL BODY', timestamp: '2026-11-09T00:00:01.000Z' } as never)
    push({ type: 'assistant', uuid: 'a1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } } as never)
    push({ type: 'user', uuid: 'legacy', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:03.000Z', message: { role: 'user', content: [{ type: 'text', text: 'LEGACY EXPANDED USER BODY' }] } } as never)
    await log.flush(); await log.close()

    const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 10 })
    expect((page.messages as Array<{ uuid: string }>).map((message) => message.uuid)).toEqual(['u1', 'a1', 'legacy'])
    expect(pageText(page)).not.toContain('PERSISTED SKILL BODY')
    expect(pageText(page)).not.toContain('session/skill')
    expect(pageText(page)).toContain('LEGACY EXPANDED USER BODY')

    // These entries feed both message search and transcript seq backfill.
    const entries = await readNativeHistoryEntries(dir, 's1', transcriptPort)
    expect(entries.map((entry) => (entry.message as { uuid: string }).uuid)).toEqual(['u1', 'a1', 'legacy'])
    expect(entries.map((entry) => entry.index)).toEqual([0, 1, 2])
    expect(JSON.stringify(entries)).not.toContain('PERSISTED SKILL BODY')

    const history = historyFromEvents(neutralEventsOf(loadNativeSessionLogSync(dir, 's1')!)) as Array<{
      content: ReadonlyArray<{ text?: string }>
    }>
    expect(history.map((message) => message.content[0]?.text)).toEqual([
      'ctx',
      '/alpha args',
      'PERSISTED SKILL BODY',
      'answer',
      'LEGACY EXPANDED USER BODY',
    ])
  })
  it('keeps session/title out of pages and search entries', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
    const push = (e: never) => log.append(e)
    push({ type: 'session/context', text: 'ctx' } as never)
    push({ type: 'user', uuid: 'u1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } } as never)
    push({ type: 'session/title', time: Date.parse('2026-11-09T00:00:01.000Z'), data: { title: 'Renamed session' } } as never)
    push({ type: 'assistant', uuid: 'a1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } } as never)
    await log.flush(); await log.close()

    const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 10 })
    expect((page.messages as Array<{ uuid: string }>).map((message) => message.uuid)).toEqual(['u1', 'a1'])
    expect(pageText(page)).not.toContain('Renamed session')
    expect(pageText(page)).not.toContain('session/title')
    const entries = await readNativeHistoryEntries(dir, 's1', transcriptPort)
    expect(entries.map((entry) => (entry.message as { uuid: string }).uuid)).toEqual(['u1', 'a1'])
    expect(JSON.stringify(entries)).not.toContain('Renamed session')
  })

  it('floors raw prompts and skill bodies for model replay without changing UI or search flooring', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
    const push = (e: never) => log.append(e)
    push({ type: 'user', uuid: 'pre', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '/before' }] } } as never)
    push({ type: 'session/skill', name: 'before', body: 'PRE-COMPACT SKILL BODY', timestamp: '2026-11-09T00:00:01.000Z' } as never)
    push({ type: 'session/compact', text: 'SUMMARY', context: 'CTX', uuid: 'c1', timestamp: '2026-11-09T00:00:02.000Z' } as never)
    push({ type: 'user', uuid: 'post', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:03.000Z', message: { role: 'user', content: [{ type: 'text', text: '/after' }] } } as never)
    push({ type: 'session/skill', name: 'after', body: 'POST-COMPACT SKILL BODY', timestamp: '2026-11-09T00:00:04.000Z' } as never)
    await log.flush(); await log.close()

    const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 10 })
    expect((page.messages as Array<{ uuid: string }>).map((message) => message.uuid)).toEqual(['c1', 'post'])
    expect(pageText(page)).not.toContain('/before')
    expect(pageText(page)).not.toContain('PRE-COMPACT SKILL BODY')
    expect(pageText(page)).not.toContain('POST-COMPACT SKILL BODY')
    expect(JSON.stringify(await readNativeHistoryEntries(dir, 's1', transcriptPort))).not.toContain('SKILL BODY')

    const history = JSON.stringify(historyFromEvents(neutralEventsOf(loadNativeSessionLogSync(dir, 's1')!)))
    expect(history).not.toContain('/before')
    expect(history).not.toContain('PRE-COMPACT SKILL BODY')
    expect(history).toContain('/after')
    expect(history).toContain('POST-COMPACT SKILL BODY')
  })
  it('keeps a v2 attachment catalog out of pages, search entries and seq backfill', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
    log.append({ type: 'user', uuid: 'plain', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-13T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'plain' }] } })
    await log.flush()
    await log.migrateToV2()
    const attachment = {
      id: 'upload-1', name: 'notes.txt', size: 123, digest: 'e'.repeat(64),
      path: '/registry/notes.txt', mediaType: 'text/plain', modelForm: 'handle' as const,
    }
    log.append({ type: 'session/attachments', attachments: [attachment], timestamp: '2026-11-13T00:00:01.000Z' })
    log.append({ type: 'user', uuid: 'structured', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-13T00:00:02.000Z', message: { role: 'user', content: [{ type: 'file', attachment }] } })
    await log.flush()
    await log.close()

    const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 10 })
    expect((page.messages as Array<{ uuid: string }>).map((message) => message.uuid)).toEqual(['plain', 'structured'])
    expect(pageText(page)).not.toContain('session/attachments')
    expect(pageText(page)).not.toContain('catalog-time')
    const entries = await readNativeHistoryEntries(dir, 's1', transcriptPort)
    expect(entries.map((entry) => (entry.message as { uuid: string }).uuid)).toEqual(['plain', 'structured'])
    expect(entries.map((entry) => entry.index)).toEqual([0, 1])
    expect(JSON.stringify(entries)).not.toContain('session/attachments')
  })
  it('restores public top-level files and omits structured files inside tool results', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
    await log.migrateToV2()
    const attachment = {
      id: 'upload-1', name: 'notes.txt', size: 123, digest: 'e'.repeat(64),
      path: '/registry/notes.txt', mediaType: 'text/plain', modelForm: 'handle' as const,
    }
    log.append({ type: 'user', uuid: 'structured', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-13T00:00:00.000Z', message: { role: 'user', content: [{ type: 'file', attachment }] } })
    log.append({ type: 'user', uuid: 'result', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-13T00:00:01.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: [{ type: 'text', text: 'read notes.txt' }, { type: 'file', attachment }], is_error: false }] } })
    await log.flush()
    await log.close()

    const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 10 })
    const messages = page.messages as Array<{ uuid: string; message: { content: Array<{ type: string; attachment?: unknown; content?: unknown[] }> } }>
    expect(messages[0].message.content[0]).toEqual({
      type: 'file', attachment: { id: attachment.id, name: attachment.name, size: attachment.size, digest: attachment.digest },
    })
    expect(messages[1].message.content[0].content).toEqual([{ type: 'text', text: 'read notes.txt' }])
    expect(pageText(page)).not.toContain('/registry/notes.txt')
    expect(pageText(page)).not.toContain('modelForm')
    expect(pageText(page)).not.toContain('mediaType')
    expect(JSON.stringify(await readNativeHistoryEntries(dir, 's1', transcriptPort))).not.toContain('/registry/notes.txt')
  })
  it('returns an empty page for a missing log', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    expect(await readNativeHistoryPage(dir, 'nope', transcriptPort, { limit: 10 })).toEqual({ messages: [], totalCount: 0, startIndex: 0, hasMore: false })
    expect(await readNativeHistoryEntries(dir, 'nope', transcriptPort)).toEqual([])
  })
  it('ignores a header whose cwd contains the compact event name', async () => {
    // The boundary scan pre-filters on the literal substring; a project
    // directory literally named `session/compact` must not make the header
    // look like an event (it has no seq and would throw).
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/work/session/compact', resume: false })
    log.append({ type: 'user', uuid: 'u1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } } as never)
    await log.flush(); await log.close()

    const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 10 })
    expect(pageText(page)).toContain('hello')
  })
})

describe('native history reader — retain compacts', () => {
  /** A retain compact must be seeded as a NEUTRAL v3 event: the legacy flat
   *  shape migrates without the retainHistory/summaryUuid markers. */
  async function seedLogWithRetainCompact() {
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
    const push = (e: never) => log.append(e)
    push({ type: 'session/context', text: 'CTX' } as never)
    push({ type: 'user', uuid: 'p1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'pre-compact' }] } } as never)
    push({ type: 'assistant', uuid: 'p2', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'pre-compact reply' }] } } as never)
    push({ type: 'session/compact', time: Date.parse('2026-11-09T00:00:02.000Z'), data: { text: 'SUMMARY', context: 'CTX', uuid: 'c1', timestamp: '2026-11-09T00:00:02.000Z', retainHistory: true, summaryUuid: 'sum-1' } } as never)
    push({ type: 'user', uuid: 'u3', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:03.000Z', message: { role: 'user', content: [{ type: 'text', text: 'post-compact' }] } } as never)
    await log.flush(); await log.close()
  }

  it('retain compact keeps pre-compact history + inline boundary and summary', async () => {
    await seedLogWithRetainCompact()
    const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 20 })
    expect(pageText(page)).toContain('pre-compact')
    expect(pageText(page)).toContain('post-compact')
    expect(pageText(page)).toContain('SUMMARY')
    expect(pageText(page)).toContain('compact_boundary')
    // The marker pair sits at the compact's seq position: after the
    // pre-compact turns, before the post-compact turn.
    expect((page.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['p1', 'p2', 'c1', 'sum-1', 'u3'])
    const entries = await readNativeHistoryEntries(dir, 's1', transcriptPort)
    expect(JSON.stringify(entries)).toContain('pre-compact')
  })

  it('retain compact summary uses summaryUuid (live==disk identity)', async () => {
    await seedLogWithRetainCompact()
    const snap = await readNativeHistorySnapshot(dir, 's1', transcriptPort)
    const summary = snap.entries.find((e) => (e.message as { isCompactSummary?: boolean }).isCompactSummary)
    expect((summary!.message as { uuid: string }).uuid).toBe('sum-1')
    const boundary = snap.entries.find((e) => (e.message as { subtype?: string }).subtype === 'compact_boundary')
    expect((boundary!.message as { uuid: string }).uuid).toBe('c1')
  })

  it('legacy compact (no marker) still floors (existing behavior unchanged)', async () => {
    await seedLogWithCompact()
    const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 20 })
    expect(pageText(page)).not.toContain('pre-compact')
  })

  it('mixed legacy + retain: legacy floor hides its pre-content, retain inserts marker', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
    const push = (e: never) => log.append(e)
    push({ type: 'session/context', text: 'CTX' } as never)
    push({ type: 'user', uuid: 'p1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'pre-legacy' }] } } as never)
    push({ type: 'session/compact', text: 'LEGACY SUMMARY', context: 'CTX', uuid: 'c1', timestamp: '2026-11-09T00:00:01.000Z' } as never)
    push({ type: 'user', uuid: 'm1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: 'post-legacy' }] } } as never)
    push({ type: 'session/compact', time: Date.parse('2026-11-09T00:00:03.000Z'), data: { text: 'RETAIN SUMMARY', context: 'CTX', uuid: 'c2', timestamp: '2026-11-09T00:00:03.000Z', retainHistory: true, summaryUuid: 'sum-2' } } as never)
    push({ type: 'user', uuid: 'u3', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:04.000Z', message: { role: 'user', content: [{ type: 'text', text: 'post-retain' }] } } as never)
    await log.flush(); await log.close()

    const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 20 })
    expect(pageText(page)).not.toContain('pre-legacy')
    expect(pageText(page)).toContain('post-legacy')
    expect(pageText(page)).toContain('LEGACY SUMMARY')
    expect(pageText(page)).toContain('RETAIN SUMMARY')
    expect(pageText(page)).toContain('post-retain')
    // entries/page keep the summary-only legacy projection; the retain marker
    // contributes boundary + summary at its seq position.
    expect((page.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['c1', 'm1', 'c2', 'sum-2', 'u3'])
    expect(JSON.stringify(await readNativeHistoryEntries(dir, 's1', transcriptPort))).not.toContain('pre-legacy')

    // The snapshot path synthesizes boundary + summary for BOTH compacts;
    // each summary keeps its own identity (legacy uuid vs summaryUuid).
    const snap = await readNativeHistorySnapshot(dir, 's1', transcriptPort)
    const summaries = snap.entries.filter((e) => (e.message as { isCompactSummary?: boolean }).isCompactSummary)
    expect(summaries.map((e) => (e.message as { uuid: string }).uuid)).toEqual(['c1', 'sum-2'])
    const boundaries = snap.entries.filter((e) => (e.message as { subtype?: string }).subtype === 'compact_boundary')
    expect(boundaries.map((e) => (e.message as { uuid: string }).uuid)).toEqual(['c1', 'c2'])
  })

  it('several retain compacts each insert their own pair, including a trailing compact', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
    const push = (e: never) => log.append(e)
    push({ type: 'user', uuid: 'p1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'first turn' }] } } as never)
    push({ type: 'session/compact', time: Date.parse('2026-11-09T00:00:01.000Z'), data: { text: 'FIRST RETAIN', context: 'CTX', uuid: 'c1', timestamp: '2026-11-09T00:00:01.000Z', retainHistory: true, summaryUuid: 'sum-1' } } as never)
    push({ type: 'user', uuid: 'm1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: 'middle turn' }] } } as never)
    // The second retain compact is the log's final event (compaction ran,
    // then the session went idle) — its pair still renders, at the tail.
    push({ type: 'session/compact', time: Date.parse('2026-11-09T00:00:03.000Z'), data: { text: 'SECOND RETAIN', context: 'CTX', uuid: 'c2', timestamp: '2026-11-09T00:00:03.000Z', retainHistory: true, summaryUuid: 'sum-2' } } as never)
    await log.flush(); await log.close()

    const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 20 })
    expect((page.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['p1', 'c1', 'sum-1', 'm1', 'c2', 'sum-2'])
    expect(pageText(page)).toContain('first turn')
    expect(pageText(page)).toContain('middle turn')
    expect(pageText(page)).toContain('FIRST RETAIN')
    expect(pageText(page)).toContain('SECOND RETAIN')
  })
})

describe('native history read seam — UI history identity (T13)', () => {
  it('projects v3 neutral events to SDK lines identical to the legacy read view', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-reader-seam-'))
    const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
    const push = (e: never) => log.append(e)
    push({ type: 'session/context', text: 'ctx' } as never)
    push({ type: 'user', uuid: 'u1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/png' } }] } } as never)
    push({ type: 'assistant', uuid: 'a1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:01.000Z', message: { role: 'assistant', id: 'msg_orig', model: 'claude-test', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a' } }], usage: { input_tokens: 10, output_tokens: 5 } } } as never)
    push({ type: 'user', uuid: 'r1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }], is_error: false }] } } as never)
    push({ type: 'assistant', uuid: 'side', session_id: 's1', parent_tool_use_id: 'agent1', timestamp: '2026-11-09T00:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'inner' }] } } as never)
    await log.flush(); await log.close()

    const snapshot = loadNativeSessionLogSync(dir, 's1')!
    expect(snapshot.header.v).toBe(3)
    const loaded = await nativeHistoryCache.load(dir, 's1')
    // The seam's SDK lines equal the compat projection's renderable subset
    // verbatim — so normalize/paginateRenderable see byte-identical input.
    // T6: no live legacy read view; project the neutral baseline to legacy.
    const legacyRenderable = snapshot.neutralEvents!
      .map((e) => projectNeutralEventToLegacy(e, 's1'))
      .filter((e) => isRenderableSdkMessage(e) || isSidechainEvent(e))
    expect(loaded!.lines).toEqual(legacyRenderable)

    // And the normalized entries equal the legacy normalize of those lines.
    const entries = await readNativeHistoryEntries(dir, 's1', transcriptPort)
    const mainLines = legacyRenderable.filter((e) => !isSidechainEvent(e))
    expect(entries.map((e) => e.message)).toEqual(mainLines.map((line) => transcriptPort.normalize(line as unknown as RawLine, 's1', false)))
  })
})
