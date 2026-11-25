// Selective listing scan + row cache for native session discovery. Fixture
// logs are written through the REAL writer (NativeSessionLog) so the scan's
// substring prefilter is pinned against actual JSON.stringify serialization,
// and torn-tail growth uses the real serializeEvent bytes.

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serializeEvent } from './native/session-log/format.js'
import { NativeSessionLog, loadNativeSessionLogSync, type NativeNeutralEventInput } from './native/session-log/log.js'
import { nativeSessionLogPath } from './native/session-log/paths.js'
import type { NativeSessionEvent } from './native/vocabulary/session-event.js'
import { createAssistantMessage, createUserMessage } from './native/vocabulary/message.js'
import {
  invalidateNativeResumableCache,
  listNativeResumableRows,
  readNativeResumableRow,
} from './native-resumable-listing.js'

const probe = vi.hoisted(() => ({
  /** createReadStream call count per path — proves cache hits do not re-read. */
  reads: new Map<string, number>(),
  /** When set, the next stat of this exact path unlinks the file right after
   *  the stat resolves — a deterministic delete between stat and read. */
  deleteAfterStat: null as string | null,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: ((path: Parameters<typeof actual.createReadStream>[0], ...rest: unknown[]) => {
      const key = String(path)
      probe.reads.set(key, (probe.reads.get(key) ?? 0) + 1)
      return (actual.createReadStream as (...args: unknown[]) => ReturnType<typeof actual.createReadStream>)(path, ...rest)
    }) as typeof actual.createReadStream,
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: (async (path: Parameters<typeof actual.stat>[0]) => {
      const result = await actual.stat(path)
      if (probe.deleteAfterStat !== null && String(path) === probe.deleteAfterStat) {
        probe.deleteAfterStat = null
        await actual.unlink(String(path))
      }
      return result
    }) as typeof actual.stat,
  }
})

let dir: string | undefined

afterEach(async () => {
  probe.reads.clear()
  probe.deleteAfterStat = null
  if (dir) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    dir = undefined
  }
})

async function freshStateDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'native-resumable-'))
  return dir
}

function userEvent(text: string, opts: { parent?: string; compact?: boolean } = {}): NativeNeutralEventInput {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  return {
    type: 'user/message',
    time: Date.now(),
    parentToolUseId: opts.parent ?? null,
    data: { ...message, ...(opts.compact ? { isCompactSummary: true as const } : {}) },
  }
}

function fileOnlyEvent(name: string): NativeNeutralEventInput {
  const message = createUserMessage({
    content: [{ type: 'file', attachment: { id: `sha256:${'a'.repeat(64)}`, name, size: 1024 } }],
    source: { kind: 'user' },
  })
  return { type: 'user/message', time: Date.now(), parentToolUseId: null, data: message }
}

function titleEvent(title: string): NativeNeutralEventInput {
  return { type: 'session/title', time: Date.now(), data: { title } }
}

function assistantEvent(text: string): NativeNeutralEventInput {
  return {
    type: 'assistant/message',
    time: Date.now(),
    parentToolUseId: null,
    data: {
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: 'anthropic', model: 'test-model' },
      }),
      stream: [],
    },
  }
}

/** Write a fixture log through the real writer. `version` opts into the
 *  writer's v1/v2 compat contract (a legacy seed version keeps legacy bytes
 *  on disk; neutral appends project through the writer's own compat path). */
async function writeFixture(
  stateDir: string,
  id: string,
  cwd: string,
  events: NativeNeutralEventInput[],
  version?: number,
): Promise<void> {
  const log = NativeSessionLog.open({
    stateDir,
    id,
    cwd,
    resume: false,
    ...(version !== undefined ? { seed: { events: [], inheritedEventCount: 0, isSeeded: false, version } } : {}),
  })
  for (const event of events) log.append(event)
  await log.flush()
  await log.close()
}

describe('enumeration', () => {
  it('lists one row per session log with header facts and stat lastModified; junk is skipped', async () => {
    const stateDir = await freshStateDir()
    const idA = randomUUID()
    const idB = randomUUID()
    await writeFixture(stateDir, idA, '/repo-a', [userEvent('hello a')])
    await writeFixture(stateDir, idB, '/repo-b', [userEvent('hello b')])
    // Junk: a plain file, a non-id directory name (no log inside), an empty
    // id-shaped directory.
    const root = join(stateDir, 'native-sessions')
    await writeFile(join(root, 'stray.txt'), 'not a session')
    await mkdir(join(root, 'not a uuid'))
    await writeFile(join(root, 'not a uuid', 'junk.txt'), 'x')
    await mkdir(join(root, randomUUID()))

    const rows = await listNativeResumableRows(stateDir)
    expect(rows).toHaveLength(2)
    const byId = new Map(rows.map((row) => [row.sessionId, row]))
    for (const [id, cwd] of [[idA, '/repo-a'], [idB, '/repo-b']] as const) {
      const row = byId.get(id)
      expect(row).toBeDefined()
      const header = loadNativeSessionLogSync(stateDir, id)!.header
      expect(row!.cwd).toBe(cwd)
      expect(row!.createdAt).toBe(header.createdAt)
      expect(row!.lastModified).toBe((await stat(nativeSessionLogPath(stateDir, id))).mtimeMs)
    }
  })

  it('returns an empty list when the native-sessions root does not exist', async () => {
    const stateDir = await freshStateDir()
    expect(await listNativeResumableRows(stateDir)).toEqual([])
  })
})

describe('previews', () => {
  it('extracts first/last eligible user text, skipping compact/sidechain/synthetic/interrupt frames', async () => {
    const stateDir = await freshStateDir()
    const id = randomUUID()
    await writeFixture(stateDir, id, '/repo', [
      userEvent('  hello   world  '),
      userEvent('compacted summary', { compact: true }),
      userEvent('sidechain prompt', { parent: 'toolu_123' }),
      userEvent('<command-name>/resume</command-name>'),
      userEvent('[Request interrupted by user]'),
      userEvent('final text'),
    ])
    const rows = await listNativeResumableRows(stateDir)
    expect(rows).toHaveLength(1)
    expect(rows[0].firstPrompt).toBe('hello world')
    expect(rows[0].lastPrompt).toBe('final text')
  })

  it('never emits an empty-string preview for whitespace-only text (reference parity)', async () => {
    const stateDir = await freshStateDir()
    const id = randomUUID()
    const idOnlyWhitespace = randomUUID()
    // Several empty text blocks join to ' ' — the reviewer's claimed trigger
    // for a truthy-but-all-whitespace `joined`.
    const emptyBlocks: NativeNeutralEventInput = {
      type: 'user/message',
      time: Date.now(),
      parentToolUseId: null,
      data: createUserMessage({
        content: [{ type: 'text', text: '' }, { type: 'text', text: '' }],
        source: { kind: 'user' },
      }),
    }
    await writeFixture(stateDir, id, '/repo', [
      userEvent('real prompt'),
      userEvent('   '),
      emptyBlocks,
    ])
    await writeFixture(stateDir, idOnlyWhitespace, '/repo', [userEvent('   ')])
    const rows = await listNativeResumableRows(stateDir)
    const byId = new Map(rows.map((row) => [row.sessionId, row]))
    // A trailing whitespace-only message must not clobber the real lastPrompt
    // with '' (parseLastUserPrompt records no hit for an empty condense).
    expect(byId.get(id)!.firstPrompt).toBe('real prompt')
    expect(byId.get(id)!.lastPrompt).toBe('real prompt')
    // A whitespace-only session has no preview at all.
    expect(byId.get(idOnlyWhitespace)!.firstPrompt).toBeUndefined()
    expect(byId.get(idOnlyWhitespace)!.lastPrompt).toBeUndefined()
  })

  it('falls back to attachment names for an attachment-only message', async () => {
    const stateDir = await freshStateDir()
    const id = randomUUID()
    await writeFixture(stateDir, id, '/repo', [fileOnlyEvent('report.pdf')])
    const rows = await listNativeResumableRows(stateDir)
    expect(rows).toHaveLength(1)
    expect(rows[0].firstPrompt).toBe('report.pdf')
    expect(rows[0].lastPrompt).toBe('report.pdf')
  })
})

describe('title', () => {
  it('latest session/title wins; no title event leaves title undefined', async () => {
    const stateDir = await freshStateDir()
    const idTitled = randomUUID()
    const idPlain = randomUUID()
    await writeFixture(stateDir, idTitled, '/repo', [
      userEvent('q'),
      titleEvent('first title'),
      titleEvent('second title'),
    ])
    await writeFixture(stateDir, idPlain, '/repo', [userEvent('q')])
    const rows = await listNativeResumableRows(stateDir)
    const byId = new Map(rows.map((row) => [row.sessionId, row]))
    expect(byId.get(idTitled)!.title).toBe('second title')
    expect(byId.get(idPlain)!.title).toBeUndefined()
  })
})

describe('legacy v2', () => {
  it('enumerates a v2 log with previews via migration (no title)', async () => {
    const stateDir = await freshStateDir()
    const id = randomUUID()
    await writeFixture(stateDir, id, '/legacy-repo', [userEvent('legacy first'), userEvent('legacy last')], 2)
    expect(loadNativeSessionLogSync(stateDir, id)!.header.v).toBe(2)
    const rows = await listNativeResumableRows(stateDir)
    expect(rows).toHaveLength(1)
    expect(rows[0].cwd).toBe('/legacy-repo')
    expect(rows[0].firstPrompt).toBe('legacy first')
    expect(rows[0].lastPrompt).toBe('legacy last')
    expect(rows[0].title).toBeUndefined()
  })
})

describe('corrupt isolation', () => {
  it('skips a corrupt log in the listing but keeps the other rows; read throws for the corrupt id', async () => {
    const stateDir = await freshStateDir()
    const good = randomUUID()
    const bad = randomUUID()
    await writeFixture(stateDir, good, '/repo', [userEvent('good prompt')])
    await writeFixture(stateDir, bad, '/repo', [userEvent('before garbage')])
    // A garbage line that hits the selective prefilter but is not valid JSON:
    // the scan parses prefilter hits, so this row is corrupt. (Garbage on a
    // non-hit line is invisible to the selective scan by design — the
    // authoritative resume path full-validates at open.)
    await appendFile(nativeSessionLogPath(stateDir, bad), '{"type":"user/message","seq":1,,}\n')

    const rows = await listNativeResumableRows(stateDir)
    expect(rows.map((row) => row.sessionId)).toEqual([good])
    await expect(readNativeResumableRow(stateDir, bad)).rejects.toThrow()
    const goodRow = await readNativeResumableRow(stateDir, good)
    expect(goodRow!.firstPrompt).toBe('good prompt')
  })

  it('read returns undefined for a missing log', async () => {
    const stateDir = await freshStateDir()
    expect(await readNativeResumableRow(stateDir, randomUUID())).toBeUndefined()
  })
})

describe('dir scope', () => {
  it('opts.dir filters to exact header.cwd matches', async () => {
    const stateDir = await freshStateDir()
    const idA = randomUUID()
    const idB = randomUUID()
    await writeFixture(stateDir, idA, '/repo-a', [userEvent('a')])
    await writeFixture(stateDir, idB, '/repo-b', [userEvent('b')])
    const scoped = await listNativeResumableRows(stateDir, { dir: '/repo-a' })
    expect(scoped.map((row) => row.sessionId)).toEqual([idA])
    expect(await listNativeResumableRows(stateDir, { dir: '/nowhere' })).toEqual([])
  })
})

describe('row cache', () => {
  it('reuses the cached row on unchanged stat, rescans on growth and shrink', async () => {
    const stateDir = await freshStateDir()
    const id = randomUUID()
    await writeFixture(stateDir, id, '/repo', [userEvent('hello')])
    const path = nativeSessionLogPath(stateDir, id)
    const reads = () => probe.reads.get(path) ?? 0

    const first = await listNativeResumableRows(stateDir)
    expect(first[0].lastPrompt).toBe('hello')
    expect(reads()).toBe(1)

    const warm = await listNativeResumableRows(stateDir)
    expect(warm[0].lastPrompt).toBe('hello')
    expect(reads()).toBe(1) // unchanged stat → no re-read

    const sizeBeforeGrowth = (await stat(path)).size
    const log = NativeSessionLog.open({ stateDir, id, cwd: '/repo', resume: true })
    log.append(userEvent('world'))
    await log.flush()
    await log.close()
    const grown = await listNativeResumableRows(stateDir)
    expect(grown[0].lastPrompt).toBe('world')
    expect(reads()).toBe(2)

    await truncate(path, sizeBeforeGrowth)
    const shrunk = await listNativeResumableRows(stateDir)
    expect(shrunk[0].lastPrompt).toBe('hello')
    expect(reads()).toBe(3)
  })

  it('invalidateNativeResumableCache forces a fresh read', async () => {
    const stateDir = await freshStateDir()
    const id = randomUUID()
    await writeFixture(stateDir, id, '/repo', [userEvent('cached')])
    const path = nativeSessionLogPath(stateDir, id)
    await listNativeResumableRows(stateDir)
    expect(probe.reads.get(path)).toBe(1)
    invalidateNativeResumableCache(id)
    await listNativeResumableRows(stateDir)
    expect(probe.reads.get(path)).toBe(2)
  })
})

describe('torn tail', () => {
  it('ignores a final unterminated line and does not consume its seq', async () => {
    const stateDir = await freshStateDir()
    const id = randomUUID()
    await writeFixture(stateDir, id, '/repo', [userEvent('complete prompt')])
    const path = nativeSessionLogPath(stateDir, id)
    // The next event (seq 1), serialized by the REAL serializer and split
    // mid-line: the prefix still carries the prefilter substring, so only the
    // torn-tail rule (not the prefilter) can keep it out of the parse.
    const next = { ...userEvent('torn prompt'), seq: 1 } as NativeSessionEvent
    const fullLine = serializeEvent(next) + '\n'
    const cut = Math.floor(fullLine.length / 2)
    await appendFile(path, fullLine.slice(0, cut))

    const torn = await listNativeResumableRows(stateDir)
    expect(torn).toHaveLength(1)
    expect(torn[0].firstPrompt).toBe('complete prompt')
    expect(torn[0].lastPrompt).toBe('complete prompt')

    // Complete the line: it must parse at seq 1 — the torn scan never counted
    // the half-line toward the seq chain.
    await appendFile(path, fullLine.slice(cut))
    const healed = await listNativeResumableRows(stateDir)
    expect(healed[0].lastPrompt).toBe('torn prompt')
  })
})

describe('delete race', () => {
  it('skips a log deleted between stat and read, without caching a negative verdict', async () => {
    const stateDir = await freshStateDir()
    const id = randomUUID()
    const other = randomUUID()
    await writeFixture(stateDir, id, '/repo', [userEvent('doomed')])
    await writeFixture(stateDir, other, '/repo', [userEvent('survivor')])
    probe.deleteAfterStat = nativeSessionLogPath(stateDir, id)

    const rows = await listNativeResumableRows(stateDir)
    expect(rows.map((row) => row.sessionId)).toEqual([other])

    // Re-create the same id: the next listing must see it (the failed scan
    // was not cached as absent).
    await writeFixture(stateDir, id, '/repo', [userEvent('reborn')])
    const after = await listNativeResumableRows(stateDir)
    const reborn = after.find((row) => row.sessionId === id)
    expect(reborn).toBeDefined()
    expect(reborn!.firstPrompt).toBe('reborn')
  })
})

describe('large log', () => {
  it('streams a multi-MB log and extracts the sparse user/title facts', async () => {
    const stateDir = await freshStateDir()
    const id = randomUUID()
    const filler = 'x'.repeat(4096)
    const events: NativeNeutralEventInput[] = [userEvent('alpha prompt')]
    for (let i = 0; i < 250; i++) events.push(assistantEvent(filler))
    events.push(titleEvent('interim title'))
    events.push(userEvent('omega prompt'))
    for (let i = 0; i < 250; i++) events.push(assistantEvent(filler))
    events.push(titleEvent('final title'))
    await writeFixture(stateDir, id, '/repo', events)
    const path = nativeSessionLogPath(stateDir, id)
    expect((await stat(path)).size).toBeGreaterThan(2 * 1024 * 1024)

    const rows = await listNativeResumableRows(stateDir)
    expect(rows).toHaveLength(1)
    expect(rows[0].firstPrompt).toBe('alpha prompt')
    expect(rows[0].lastPrompt).toBe('omega prompt')
    expect(rows[0].title).toBe('final title')
    // One streaming pass — not a whole-file read.
    expect(probe.reads.get(path)).toBe(1)
  }, 30_000)
})
