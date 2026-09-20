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

describe('SnapshotService', () => {
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

  it('appendPatch records changed files and updates last tree', async () => {
    const tree1 = await svc.capture({ sessionId: 's4', cwd: wt })
    expect(tree1).toBeTruthy()

    await writeFile(join(wt, 'a.txt'), 'changed\n')
    await writeFile(join(wt, 'c.txt'), 'c\n')

    const tree2 = await svc.capture({ sessionId: 's4', cwd: wt })
    expect(tree2).toBeTruthy()

    await svc.appendPatch('s4', 'A1', tree2!)

    // Verify via store (re-capture + listAnchors don't expose patches,
    // so do a fresh dryRun against a recorded anchor to verify meta is intact)
    await svc.recordAnchor('s4', wt, 'U1', tree1!)
    const dry = await svc.dryRun('s4', 'U1')
    expect(dry.canRewind).toBe(true)
    expect(dry.filesChanged?.sort()).toEqual(['a.txt', 'c.txt'])
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
