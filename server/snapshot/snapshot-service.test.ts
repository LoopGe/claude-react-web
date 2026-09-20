import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotService } from './snapshot-service.js'

const execFileAsync = promisify(execFile)
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd, windowsHide: true })

let wt: string
let state: string
let svc: SnapshotService

beforeEach(async () => {
  wt = await mkdtemp(join(tmpdir(), 'svc-wt-'))
  state = await mkdtemp(join(tmpdir(), 'svc-state-'))
  await git(wt, ['init'])
  await git(wt, ['config', 'user.email', 't@t.test'])
  await git(wt, ['config', 'user.name', 'T'])
  await git(wt, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(wt, 'a.txt'), 'one\n')
  await git(wt, ['add', '.'])
  await git(wt, ['commit', '-m', 'init'])
  svc = new SnapshotService({ stateDir: state })
})
afterEach(async () => {
  await rm(wt, { recursive: true, force: true }).catch(() => {})
  await rm(state, { recursive: true, force: true }).catch(() => {})
})

// Real git subprocesses dominate the timing of these tests; give the
// whole suite a 30s per-test ceiling so cold-start spawns don't flake.
describe('SnapshotService', { timeout: 30_000 }, () => {
  it('captures, dry-runs, and rewinds including deleting new files', async () => {
    const start = await svc.capture({ sessionId: 's1', cwd: wt })
    expect(start).toBeTruthy()

    await svc.recordAnchor('s1', wt, 'U1', start!)

    await writeFile(join(wt, 'a.txt'), 'two\n')
    await writeFile(join(wt, 'new.txt'), 'n\n')

    const dry = await svc.dryRun('s1', 'U1')
    expect(dry.canRewind).toBe(true)
    expect(dry.filesChanged?.sort()).toEqual(['a.txt', 'new.txt'])
    // dry-run must not restore
    expect(await readFile(join(wt, 'a.txt'), 'utf8')).toBe('two\n')

    const real = await svc.rewind('s1', 'U1')
    expect(real.canRewind).toBe(true)
    expect(await readFile(join(wt, 'a.txt'), 'utf8')).toBe('one\n')
    await expect(access(join(wt, 'new.txt'))).rejects.toThrow()
  })

  it('reports unavailable for non-git cwd', async () => {
    const t = await mkdtemp(join(tmpdir(), 'nogit-'))
    try {
      const tree = await svc.capture({ sessionId: 's2', cwd: t })
      expect(tree).toBeNull()
    } finally {
      await rm(t, { recursive: true, force: true })
    }
  })

  it('listAnchors returns newest-first order', async () => {
    const tree1 = await svc.capture({ sessionId: 's3', cwd: wt })
    expect(tree1).toBeTruthy()
    await svc.recordAnchor('s3', wt, 'U1', tree1!)

    await writeFile(join(wt, 'b.txt'), 'b\n')
    const tree2 = await svc.capture({ sessionId: 's3', cwd: wt })
    expect(tree2).toBeTruthy()
    await svc.recordAnchor('s3', wt, 'U2', tree2!)

    const anchors = await svc.listAnchors('s3')
    expect(anchors).toHaveLength(2)
    expect(anchors[0].messageId).toBe('U2')
    expect(anchors[1].messageId).toBe('U1')
  })

  it('listAnchors returns empty for unknown session', async () => {
    expect(await svc.listAnchors('nonexistent')).toEqual([])
  })

  it('recordAnchor is a no-op when no meta exists yet (capture must run first)', async () => {
    await svc.recordAnchor('no-meta', wt, 'U1', 'fake-tree-hash')
    const anchors = await svc.listAnchors('no-meta')
    expect(anchors).toEqual([])
  })

  it('appendPatch records changed files and updates last tree', async () => {
    const tree1 = await svc.capture({ sessionId: 's4', cwd: wt })
    expect(tree1).toBeTruthy()

    await writeFile(join(wt, 'a.txt'), 'changed\n')
    await writeFile(join(wt, 'c.txt'), 'c\n')

    const tree2 = await svc.capture({ sessionId: 's4', cwd: wt })
    expect(tree2).toBeTruthy()

    // Pass tree1 as the prev tree explicitly — without it, appendPatch
    // would read meta.last.tree (which capture() just overwrote to
    // tree2), making the diff tree2→tree2 = empty. The pump's
    // recordTurnSnapshot reads prev BEFORE calling capture to avoid this.
    await svc.appendPatch('s4', 'A1', tree2!, tree1)

    // Verify the patch was actually recorded in meta.patches (the prior
    // test only checked dryRun, which uses byMessage anchors — a no-op
    // appendPatch would pass that check while patches stayed empty).
    const { SnapshotStore } = await import('./snapshot-store.js')
    const store = new SnapshotStore(state)
    const meta = await store.load('s4')
    expect(meta?.patches).toHaveLength(1)
    expect(meta?.patches[0].messageId).toBe('A1')
    expect(meta?.patches[0].hash).toBe(tree1)
    expect(meta?.patches[0].files.length).toBe(2)
    expect(meta?.last?.tree).toBe(tree2)

    // Also verify via dryRun against a recorded anchor.
    await svc.recordAnchor('s4', wt, 'U1', tree1!)
    const dry = await svc.dryRun('s4', 'U1')
    expect(dry.canRewind).toBe(true)
    expect(dry.filesChanged?.sort()).toEqual(['a.txt', 'c.txt'])
  })

  it('appendPatch without prevTree falls back to meta.last.tree (no-op when caller forgot the prev)', async () => {
    // This documents the footgun: calling appendPatch AFTER capture
    // (which overwrote meta.last) makes the diff empty. Callers should
    // pass prevTree explicitly (as recordTurnSnapshot does).
    const tree1 = await svc.capture({ sessionId: 's-fallback', cwd: wt })
    expect(tree1).toBeTruthy()
    await writeFile(join(wt, 'a.txt'), 'changed-again\n')
    const tree2 = await svc.capture({ sessionId: 's-fallback', cwd: wt })
    await svc.appendPatch('s-fallback', 'A1', tree2!)  // no prevTree
    const { SnapshotStore } = await import('./snapshot-store.js')
    const store = new SnapshotStore(state)
    const meta = await store.load('s-fallback')
    // No patch recorded (diff was tree2→tree2 = empty), but last is
    // updated to tree2 — so the turn is a no-op patch, not a missed
    // capture.
    expect(meta?.patches).toHaveLength(0)
    expect(meta?.last?.tree).toBe(tree2)
  })

  it('capture is idempotent when nothing changes', async () => {
    const t1 = await svc.capture({ sessionId: 's5', cwd: wt })
    const t2 = await svc.capture({ sessionId: 's5', cwd: wt })
    expect(t1).toBe(t2)
  })

  it('dryRun returns canRewind false for missing anchor', async () => {
    const tree = await svc.capture({ sessionId: 's6', cwd: wt })
    expect(tree).toBeTruthy()
    const result = await svc.dryRun('s6', 'nonexistent-uuid')
    expect(result.canRewind).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('rewind returns canRewind false for unknown session', async () => {
    const result = await svc.rewind('unknown', 'U1')
    expect(result.canRewind).toBe(false)
  })

  it('capture returns null when fileSnapshots is disabled', async () => {
    const disabled = new SnapshotService({ stateDir: state, fileSnapshots: false })
    const tree = await disabled.capture({ sessionId: 's7', cwd: wt })
    expect(tree).toBeNull()
  })

  it('rewind deletes files that were absent from the start tree', async () => {
    const start = await svc.capture({ sessionId: 's8', cwd: wt })
    expect(start).toBeTruthy()
    await svc.recordAnchor('s8', wt, 'U1', start!)

    // New file that didn't exist at capture time
    await writeFile(join(wt, 'brand-new.txt'), 'brand\n')
    // Also modify existing
    await writeFile(join(wt, 'a.txt'), 'modified\n')

    const result = await svc.rewind('s8', 'U1')
    expect(result.canRewind).toBe(true)
    // Original file restored
    expect(await readFile(join(wt, 'a.txt'), 'utf8')).toBe('one\n')
    // New file deleted
    await expect(access(join(wt, 'brand-new.txt'))).rejects.toThrow()
  })

  it('structured diffs include patch text', async () => {
    const start = await svc.capture({ sessionId: 's9', cwd: wt })
    expect(start).toBeTruthy()
    await svc.recordAnchor('s9', wt, 'U1', start!)

    await writeFile(join(wt, 'a.txt'), 'two\n')

    const dry = await svc.dryRun('s9', 'U1')
    expect(dry.canRewind).toBe(true)
    expect(dry.diffs).toHaveLength(1)
    expect(dry.diffs![0].file).toBe('a.txt')
    expect(dry.diffs![0].status).toBe('modified')
    expect(dry.diffs![0].patch).toContain('@@')
    expect(dry.diffs![0].additions).toBeGreaterThan(0)
  })
})
