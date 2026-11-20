import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { HttpError } from './errors.js'
import { createPushable } from './pushable.js'
import {
  ScheduledSendManager,
  MIN_DELAY_MS,
  MAX_PENDING_PER_SESSION,
  type ScheduledSendDeps,
} from './scheduled-send-manager.js'
import type { ScheduledSendBody } from '../shared/scheduled-send.js'
import { AttachmentObjectStore } from './attachment-object-store.js'
import { isResolvedImageBlock, resolveImageBlocks, type ResolvedImageBlock } from './attachment-resolver.js'
import type { ProviderContentBlock } from './agent-message.js'
import { attachmentRoot, imageObjectPathOf } from './attachment-paths.js'
import { imageRefId, type ImageAttachmentRef, type ImageRefBlock } from '../shared/image-attachment.js'
import { inspectImageBytes } from '../shared/image-inspect.js'

/** Build a manager with a controllable clock + fake send. Does NOT start
 *  timers (tickMs keeps the interval inert at 24 h); tests drive tick()
 *  directly. */
function make(deps?: Partial<ScheduledSendDeps>) {
  let now = 1_000_000
  const send = vi.fn(async (_sessionId: string, _body: ScheduledSendBody) => ({ uuid: 'sent-uuid' }))
  const m = new ScheduledSendManager({
    send,
    now: () => now,
    tickMs: 86_400_000,
    ...deps,
  })
  return { m, send, setNow: (n: number) => { now = n } }
}

describe('ScheduledSendManager', () => {
  it('create rejects a fireAt in the past or too close', () => {
    const { m } = make() // initial now is fixed at 1_000_000
    expect(() => m.create('s1', { text: 'hi' }, 1_000_000 + MIN_DELAY_MS)).toThrow(HttpError)
    expect(() => m.create('s1', { text: 'hi' }, Number.NaN)).toThrow(HttpError)
  })

  it('create returns a pending record and list() shows it', () => {
    const { m } = make()
    const rec = m.create('s1', { text: 'hi' }, 2_000_000)
    expect(rec).toMatchObject({ sessionId: 's1', body: { text: 'hi' }, status: 'pending' })
    expect(m.list('s1').map((r) => r.id)).toEqual([rec.id])
  })

  it('create enforces the per-session pending cap', () => {
    const { m } = make()
    const t = 2_000_000
    for (let i = 0; i < MAX_PENDING_PER_SESSION; i++) m.create('s1', { text: `m${i}` }, t + i)
    expect(() => m.create('s1', { text: 'overflow' }, t + 1000)).toThrow(/too many/)
  })

  it('tick sends a due pending and marks it sent', async () => {
    const { m, send, setNow } = make()
    m.create('s1', { text: 'hi' }, 2_000_000)
    setNow(2_000_001)
    await m.tick()
    expect(send).toHaveBeenCalledWith('s1', { text: 'hi' })
    expect(m.list('s1')[0]?.status).toBe('sent')
  })

  it('tick leaves an undue pending alone', async () => {
    const { m, send } = make()
    m.create('s1', { text: 'hi' }, 2_000_000)
    await m.tick()
    expect(send).not.toHaveBeenCalled()
    expect(m.list('s1')[0]?.status).toBe('pending')
  })

  it('tick marks a send failure as failed with reason', async () => {
    const { m, setNow } = make({
      send: vi.fn(async () => { throw new HttpError(410, 'session s1 is terminated') }),
    })
    m.create('s1', { text: 'hi' }, 2_000_000)
    setNow(2_000_001)
    await m.tick()
    expect(m.list('s1')[0]?.status).toBe('failed')
    expect(m.list('s1')[0]?.error).toMatch(/terminated/)
  })

  it('remove on a pending record cancels it', () => {
    const { m } = make()
    const rec = m.create('s1', { text: 'hi' }, 2_000_000)
    m.remove('s1', rec.id)
    expect(m.list('s1')[0]?.status).toBe('cancelled')
  })

  it('remove on a terminal record drops it (dismiss)', () => {
    const { m } = make()
    const rec = m.create('s1', { text: 'hi' }, 2_000_000)
    m.remove('s1', rec.id) // pending → cancelled (terminal ring)
    m.remove('s1', rec.id) // terminal → removed
    expect(m.list('s1').some((r) => r.id === rec.id)).toBe(false)
  })

  it('remove on an unknown id throws 404', () => {
    const { m } = make()
    expect(() => m.remove('s1', 'nope')).toThrow(HttpError)
  })

  it('cancelAll drops the session entirely', () => {
    const { m } = make()
    m.create('s1', { text: 'hi' }, 2_000_000)
    m.cancelAll('s1')
    expect(m.list('s1')).toEqual([])
  })

  it('subscribes to global removal and cancels that session', async () => {
    const queue = createPushable<{ kind: string; id?: string }>('test-global')
    const { m } = make({ subscribeGlobal: () => ({ iterable: queue.iterable, unsubscribe: () => queue.end() }) })
    // Create BOTH sessions first, then push removal — otherwise the async
    // consumer could process `removed s1` before create(s1) registers it.
    m.create('s1', { text: 'hi' }, 2_000_000)
    m.create('s2', { text: 'keep' }, 2_000_000)
    queue.push({ kind: 'removed', id: 's1' })
    // Let the manager's background consumer drain the pushed event.
    await new Promise((r) => setTimeout(r, 0))
    expect(m.list('s1')).toEqual([])
    expect(m.list('s2')).toHaveLength(1)
    m.shutdown()
  })

  it('shutdown stops the interval', async () => {
    const { m } = make()
    m.shutdown()
    // No private-field peek: shutdown must leave tick() safe to call.
    await expect(m.tick()).resolves.toBeUndefined()
  })
})

/** Fire-time image-ref semantics. The send delegate mirrors the production
 *  wiring (routes/index.ts → sm.sendContent): it runs the SINGLE-SOURCE
 *  resolver (resolveImageBlocks) over the content body, so these tests prove
 *  the manager's fire path composes with real verification — the manager
 *  itself adds no verification layer. A rejecting resolver must surface as a
 *  `failed` schedule (the existing tick catch), never a dangling send. */
describe('ScheduledSendManager — image ref schedules (Task 7)', () => {
  const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const pngBytes = Buffer.from(PNG_1X1, 'base64')

  let dir: string
  let store: AttachmentObjectStore
  let resolvedPayloads: (ProviderContentBlock | ResolvedImageBlock)[][]
  let send: ReturnType<typeof vi.fn>
  let now: number
  let m: ScheduledSendManager

  /** Published objects are 0o400; Windows refuses to delete a read-only file,
   *  so clear the attribute before removing the tree (same as the store tests). */
  function cleanup(root: string): void {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.isDirectory()) cleanup(path)
      else chmodSync(path, 0o600)
    }
    rmSync(root, { recursive: true, force: true })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crw-sched-'))
    store = new AttachmentObjectStore(dir)
    resolvedPayloads = []
    now = 1_000_000
    send = vi.fn(async (_sessionId: string, body: ScheduledSendBody) => {
      if ('content' in body) {
        // The schedule route rejects FileBlocks, so content is text/image-only
        // — the same boundary cast sendContent's no-file path uses.
        const resolved = await resolveImageBlocks(
          body.content as (ProviderContentBlock | ImageRefBlock)[],
          { signal: new AbortController().signal, stateDir: dir },
        )
        resolvedPayloads.push(resolved)
      }
      return { uuid: 'sent-uuid' }
    })
    m = new ScheduledSendManager({ send, now: () => now, tickMs: 86_400_000 })
  })

  afterEach(() => {
    m.shutdown()
    cleanup(dir)
  })

  const refBlock = (ref: ImageAttachmentRef): ImageRefBlock => ({ type: 'image', attachment: ref })

  async function publishFixture(): Promise<ImageAttachmentRef> {
    const inspected = inspectImageBytes(pngBytes)
    if (!inspected.ok) throw new Error('fixture PNG must inspect')
    const pub = await store.publishImage(pngBytes, inspected.image)
    return {
      id: imageRefId(pub.digest),
      mediaType: inspected.image.mediaType,
      bytes: pub.bytes,
      width: inspected.image.width,
      height: inspected.image.height,
    }
  }

  it('fires a ref schedule resolved and verified at fire time', async () => {
    const ref = await publishFixture()
    const body: ScheduledSendBody = { content: [{ type: 'text', text: 'look' }, refBlock(ref)] }
    const rec = m.create('s1', body, 2_000_000)
    now = 2_000_001
    await m.tick()
    // The manager hands the delegate the ref body verbatim — no base64 inlining.
    expect(send).toHaveBeenCalledWith('s1', body)
    const fired = m.list('s1').find((r) => r.id === rec.id)!
    expect(fired.status).toBe('sent')
    expect(fired.sentUuid).toBe('sent-uuid')
    // The stored body stays ref-only after the fire.
    expect(fired.body).toEqual(body)
    // The delegate's resolver verified the stored bytes at fire time.
    expect(resolvedPayloads).toHaveLength(1)
    const resolved = resolvedPayloads[0]
    expect(resolved[0]).toEqual({ type: 'text', text: 'look' })
    expect(isResolvedImageBlock(resolved[1])).toBe(true)
    const img = resolved[1] as ResolvedImageBlock
    expect(img.attachment).toEqual(ref)
    expect(img.source).toEqual({ type: 'base64', data: PNG_1X1, media_type: 'image/png' })
  })

  it('marks a schedule failed when its image is missing at fire time (no retry)', async () => {
    const missing: ImageAttachmentRef = {
      id: imageRefId('f'.repeat(64)), mediaType: 'image/png', bytes: 68, width: 1, height: 1,
    }
    const rec = m.create('s1', { content: [refBlock(missing)] }, 2_000_000)
    // create() does not verify — the dangling ref is accepted as pending.
    expect(m.list('s1')[0].status).toBe('pending')
    now = 2_000_001
    await m.tick()
    const fired = m.list('s1').find((r) => r.id === rec.id)!
    expect(fired.status).toBe('failed')
    expect(fired.error).toMatch(/image not found/)
    expect(fired.sentUuid).toBeUndefined()
    // A second tick must not re-fire the failed schedule.
    await m.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('marks a schedule failed when its stored bytes are corrupt at fire time', async () => {
    const ref = await publishFixture()
    const objectPath = imageObjectPathOf(attachmentRoot(dir), ref.id.slice('sha256:'.length))
    chmodSync(objectPath, 0o600)
    const tampered = Uint8Array.from(pngBytes)
    tampered[0] ^= 0xff
    writeFileSync(objectPath, tampered)
    const rec = m.create('s1', { content: [refBlock(ref)] }, 2_000_000)
    now = 2_000_001
    await m.tick()
    const fired = m.list('s1').find((r) => r.id === rec.id)!
    expect(fired.status).toBe('failed')
    expect(fired.error).toMatch(/integrity/)
    expect(fired.sentUuid).toBeUndefined()
  })

  it('fires a legacy base64 schedule unchanged', async () => {
    const body: ScheduledSendBody = {
      content: [
        { type: 'text', text: 'old' },
        { type: 'image', source: { type: 'base64', data: PNG_1X1, media_type: 'image/png' } },
      ],
    }
    const rec = m.create('s1', body, 2_000_000)
    now = 2_000_001
    await m.tick()
    expect(send).toHaveBeenCalledWith('s1', body)
    expect(m.list('s1').find((r) => r.id === rec.id)!.status).toBe('sent')
    // The resolver passes non-ref blocks through untouched.
    expect(resolvedPayloads[0]).toEqual(body.content)
  })

  it('verifies at fire time, not create time (image published after create still fires)', async () => {
    const inspected = inspectImageBytes(pngBytes)
    if (!inspected.ok) throw new Error('fixture PNG must inspect')
    const digest = createHash('sha256').update(pngBytes).digest('hex')
    const ref: ImageAttachmentRef = {
      id: imageRefId(digest),
      mediaType: inspected.image.mediaType,
      bytes: pngBytes.byteLength,
      width: inspected.image.width,
      height: inspected.image.height,
    }
    const rec = m.create('s1', { content: [refBlock(ref)] }, 2_000_000)
    // The object does not exist yet at create time; publish it before the fire.
    await store.publishImage(pngBytes, inspected.image)
    now = 2_000_001
    await m.tick()
    expect(m.list('s1').find((r) => r.id === rec.id)!.status).toBe('sent')
  })
})
