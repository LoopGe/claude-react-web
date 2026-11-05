import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotService } from './snapshot-service.js'
import { capturesDir } from './paths.js'

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

  it('dryRun returns file stats without patches (diffStats)', async () => {
    const start = await svc.capture({ sessionId: 's9', cwd: wt })
    expect(start).toBeTruthy()
    await svc.recordAnchor('s9', wt, 'U1', start!)

    await writeFile(join(wt, 'a.txt'), 'two\n')

    const dry = await svc.dryRun('s9', 'U1')
    expect(dry.canRewind).toBe(true)
    // dryRun uses diffStats (no per-file patches) — patches are reserved
    // for the GET /snapshot-diff endpoint (structuredDiff).
    expect(dry.filesChanged).toContain('a.txt')
    expect(dry.insertions).toBeGreaterThan(0)
    expect(dry.diffs).toBeUndefined()
  })

  it('diffFromAnchor returns structured patches for review UI', async () => {
    const start = await svc.capture({ sessionId: 's9-diff', cwd: wt })
    expect(start).toBeTruthy()
    await svc.recordAnchor('s9-diff', wt, 'U1', start!)

    await writeFile(join(wt, 'a.txt'), 'two\n')

    const diffs = await svc.diffFromAnchor('s9-diff', 'U1')
    expect(diffs).toHaveLength(1)
    expect(diffs[0].file).toBe('a.txt')
    expect(diffs[0].status).toBe('modified')
    expect(diffs[0].patch).toContain('@@')
    expect(diffs[0].additions).toBeGreaterThan(0)
  })

  it('records tree changes and captured ignored files in one summary', async () => {
    await writeFile(join(wt, '.gitignore'), '*.local\n')
    await writeFile(join(wt, 'notes.local'), 'start\n')
    const start = await svc.capture({ sessionId: 's-turn', cwd: wt })
    const before = await svc.captureToolTarget('s-turn', join(wt, 'notes.local'))
    await writeFile(join(wt, 'a.txt'), 'one\ntwo\n')
    await writeFile(join(wt, 'notes.local'), 'start\ndone\n')
    const summary = await svc.recordTurn({
      sessionId: 's-turn', cwd: wt, resultUuid: 'r-turn', assistantUuid: 'a-turn',
      startTree: start, captures: new Map([[join(wt, 'notes.local'), before]]),
    })
    expect(summary?.files.map((f) => [f.display, f.status, f.additions])).toEqual([
      ['a.txt', 'modified', 1],
      ['notes.local', 'modified', 1],
    ])
    expect(summary?.total).toBe(2)
    expect(summary?.added).toBe(2)
    expect(summary?.deleted).toBe(0)
    expect((await svc.turnDiff('s-turn', 'r-turn', 1)).patch).toContain('+done')
  })

  it('serves complete unclipped full-file context for tree and copy sources', async () => {
    const treeBefore = Array.from({ length: 20 }, (_, i) => `tree ${i + 1}`)
    const copyBefore = Array.from({ length: 600 }, (_, i) => `copy ${i + 1}`)
    await writeFile(join(wt, '.gitignore'), '*.local\n')
    await writeFile(join(wt, 'a.txt'), `${treeBefore.join('\n')}\n`)
    await writeFile(join(wt, 'notes.local'), `${copyBefore.join('\n')}\n`)
    const start = await svc.capture({ sessionId: 's-full-file', cwd: wt })
    const before = await svc.captureToolTarget('s-full-file', join(wt, 'notes.local'))

    const treeAfter = [...treeBefore]
    treeAfter[1] = 'tree 2 changed'
    treeAfter[19] = 'tree 20 changed'
    const copyAfter = [...copyBefore]
    copyAfter[1] = 'copy 2 changed'
    copyAfter[599] = 'copy 600 changed'
    await writeFile(join(wt, 'a.txt'), `${treeAfter.join('\n')}\n`)
    await writeFile(join(wt, 'notes.local'), `${copyAfter.join('\n')}\n`)
    await svc.recordTurn({
      sessionId: 's-full-file', cwd: wt, resultUuid: 'r-full-file', assistantUuid: 'a-full-file',
      startTree: start, captures: new Map([[join(wt, 'notes.local'), before]]),
    })

    const tree = await svc.turnDiff('s-full-file', 'r-full-file', 0, { view: 'full-file', full: true })
    expect(tree.patch).toContain(' tree 10\n')
    const copy = await svc.turnDiff('s-full-file', 'r-full-file', 1, { view: 'full-file', full: true })
    expect(copy.truncated).toBe(false)
    expect(copy.totalLines).toBeGreaterThan(500)
    expect(copy.patch).toContain(' copy 300\n')
    expect(copy.patch).toContain('+copy 600 changed')
  })

  it('lists a captured path above the session cwd as ../<path>', async () => {
    await mkdir(join(wt, 'sub'))
    const cwd = join(wt, 'sub')
    const start = await svc.capture({ sessionId: 's-outer', cwd })
    const before = await svc.captureToolTarget('s-outer', join(wt, 'a.txt'))
    await writeFile(join(wt, 'a.txt'), 'changed\n')
    const summary = await svc.recordTurn({
      sessionId: 's-outer', cwd, resultUuid: 'r-outer', assistantUuid: 'a-outer',
      startTree: start, captures: new Map([[join(wt, 'a.txt'), before]]),
    })
    expect(summary?.files[0]?.display).toBe('../a.txt')
    expect((await svc.turnDiff('s-outer', 'r-outer', 0)).patch).toContain('+changed')
  })

  it('survives a restart and replaces a record by resultUuid', async () => {
    const start = await svc.capture({ sessionId: 's-restart', cwd: wt })
    const before = await svc.captureToolTarget('s-restart', join(wt, 'a.txt'))
    const input = {
      sessionId: 's-restart', cwd: wt, resultUuid: 'r-restart', assistantUuid: 'a-restart',
      startTree: start, captures: new Map([[join(wt, 'a.txt'), before]]),
    }
    await writeFile(join(wt, 'a.txt'), 'one\ntwo\n')
    expect((await svc.recordTurn(input))?.files[0]?.additions).toBe(1)

    const fresh = new SnapshotService({ stateDir: state })
    expect((await fresh.turnChanges('s-restart', 'r-restart'))?.resultUuid).toBe('r-restart')

    await writeFile(join(wt, 'a.txt'), 'one\ntwo\nthree\n')
    expect((await svc.recordTurn(input))?.files[0]?.additions).toBe(2)
    const replaced = await fresh.turnChanges('s-restart', 'r-restart')
    expect(replaced?.files).toHaveLength(1)
    expect(replaced?.files[0]?.additions).toBe(2)
  })

  it('returns null for a no-change turn', async () => {
    const start = await svc.capture({ sessionId: 's-nochange', cwd: wt })
    expect(await svc.recordTurn({
      sessionId: 's-nochange', cwd: wt, resultUuid: 'r-nochange', assistantUuid: 'a-nochange',
      startTree: start, captures: new Map(),
    })).toBeNull()
  })

  it('keeps turns across a real rewind and removes captures on delete', async () => {
    const start = await svc.capture({ sessionId: 's-keep', cwd: wt })
    await svc.recordAnchor('s-keep', wt, 'U1', start!)
    // The before-copy exists so the captures directory is created before the turn.
    await writeFile(join(wt, 'notes.local'), 'start\n')
    const before = await svc.captureToolTarget('s-keep', join(wt, 'notes.local'))
    await writeFile(join(wt, 'notes.local'), 'start\ndone\n')
    await writeFile(join(wt, 'a.txt'), 'two\n')
    const summary = await svc.recordTurn({
      sessionId: 's-keep', cwd: wt, resultUuid: 'r-keep', assistantUuid: 'a-keep',
      startTree: start, captures: new Map([[join(wt, 'notes.local'), before]]),
    })
    expect(summary?.total).toBe(2)

    const rew = await svc.rewind('s-keep', 'U1')
    expect(rew.canRewind).toBe(true)
    expect((await svc.turnChanges('s-keep', 'r-keep'))?.resultUuid).toBe('r-keep')

    await expect(access(capturesDir(state, 's-keep'))).resolves.toBeUndefined()
    await svc.delete('s-keep')
    await expect(access(capturesDir(state, 's-keep'))).rejects.toThrow()
  })

  it('real rewind invalidates later anchors (F5)', async () => {
    // Record 3 anchors at different states
    const tree1 = await svc.capture({ sessionId: 's-f5', cwd: wt })
    expect(tree1).toBeTruthy()
    await svc.recordAnchor('s-f5', wt, 'U1', tree1!)

    await writeFile(join(wt, 'a.txt'), 'two\n')
    const tree2 = await svc.capture({ sessionId: 's-f5', cwd: wt })
    expect(tree2).toBeTruthy()
    await svc.recordAnchor('s-f5', wt, 'U2', tree2!)

    await writeFile(join(wt, 'b.txt'), 'b\n')
    const tree3 = await svc.capture({ sessionId: 's-f5', cwd: wt })
    expect(tree3).toBeTruthy()
    await svc.recordAnchor('s-f5', wt, 'U3', tree3!)

    // All 3 anchors present
    let anchors = await svc.listAnchors('s-f5')
    expect(anchors).toHaveLength(3)

    // Rewind to the first anchor
    const result = await svc.rewind('s-f5', 'U1')
    expect(result.canRewind).toBe(true)

    // Only the first anchor should remain — later ones were invalidated
    anchors = await svc.listAnchors('s-f5')
    expect(anchors).toHaveLength(1)
    expect(anchors[0].messageId).toBe('U1')
  })
})
