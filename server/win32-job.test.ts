import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { metrics } from './metrics.js'
import {
  captureBirthTime,
  createJobForProcess,
  killTreeWin32,
  processIdentity,
  type Win32Job,
} from './win32-job.js'

// Real-process pins for the Win32 primitives. Every test spawns a child that
// spawns a sleeping grandchild, and afterEach unconditionally taskkills both
// pids so a failed assertion never leaks sleepers into the process table.
const cleanupPids: number[] = []
const cleanupJobs: Win32Job[] = []

/** Spawn a child that waits for one stdin line, then spawns a sleeping
 *  grandchild (stdio:'ignore'), prints the grandchild's pid to stdout, and
 *  stays alive — the treeSpawnOpts shape from process-monitor.test.ts with
 *  one deliberate addition: the grandchild spawn is GATED on stdin. Windows
 *  Job membership only captures descendants spawned AFTER assignment (a
 *  pre-spawned grandchild stays outside the Job — verified against
 *  AssignProcessToJobObject accounting), so the Job test must assign the
 *  child before releasing the grandchild. */
function spawnTreeChild(): ChildProcess {
  const script =
    `const {spawn}=require('child_process');` +
    `process.stdin.once('data',()=>{` +
    `const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
    `console.log(c.pid);` +
    `});` +
    `setInterval(()=>{},1000)`
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  })
  cleanupPids.push(child.pid!)
  return child
}

/** Read the first stdout line of the child (the grandchild's pid). */
function firstStdoutLine(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const stdout = child.stdout!
    stdout.setEncoding('utf8')
    let buf = ''
    const timer = setTimeout(() => reject(new Error('child printed no pid within 5s')), 5000)
    const onChunk = (chunk: string) => {
      buf += chunk
      const idx = buf.indexOf('\n')
      if (idx >= 0) {
        clearTimeout(timer)
        stdout.off('data', onChunk)
        resolve(Number.parseInt(buf.slice(0, idx).trim(), 10))
      }
    }
    stdout.on('data', onChunk)
  })
}

/** Release the gated grandchild and resolve its pid. */
function releaseGrandchild(child: ChildProcess): Promise<number> {
  const pending = firstStdoutLine(child)
  child.stdin!.write('go\n')
  return pending
}

/** Poll until `process.kill(pid, 0)` throws — the process is gone. */
async function expectGone(pid: number, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await new Promise((r) => setTimeout(r, 20))
    } catch {
      return
    }
  }
  throw new Error(`pid ${pid} still alive after ${ms}ms`)
}

function expectAlive(pid: number): void {
  expect(() => process.kill(pid, 0)).not.toThrow()
}

describe.runIf(process.platform === 'win32')('win32-job primitives', () => {
  afterEach(() => {
    // Close tracked Jobs first (kill-on-close reaps any live members), then
    // taskkill both pids unconditionally as the backstop for non-members.
    for (const job of cleanupJobs.splice(0)) job.close()
    for (const pid of cleanupPids.splice(0)) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    }
  })

  it('createJobForProcess + terminate kills child and grandchild', async () => {
    const child = spawnTreeChild()
    const job = createJobForProcess(child.pid!)
    cleanupJobs.push(job)
    // Grandchild spawns AFTER assignment, so it joins the Job.
    const grandchildPid = await releaseGrandchild(child)
    cleanupPids.push(grandchildPid)
    expect(job.activeCount()).toBeGreaterThanOrEqual(2)

    const before = metrics.snapshot().counters['containment_job_terminate'] ?? 0
    job.terminate()
    job.terminate() // idempotent: no second TerminateJobObject, no second count
    expect(metrics.snapshot().counters['containment_job_terminate'] ?? 0).toBe(before + 1)

    await expectGone(child.pid!)
    await expectGone(grandchildPid)
    job.close()
    job.close() // idempotent
  }, 15_000)

  it('processIdentity is stable per process and differs across processes', async () => {
    const child = spawnTreeChild()
    const grandchildPid = await releaseGrandchild(child)
    cleanupPids.push(grandchildPid)

    const a = processIdentity(child.pid!)
    expect(a).not.toBeNull()
    expect(a).toMatch(/^[0-9]+$/) // decimal 100ns FILETIME ticks
    expect(processIdentity(child.pid!)).toBe(a)
    const g = processIdentity(grandchildPid)
    expect(g).not.toBeNull()
    expect(g).not.toBe(a)

    // An unreadable pid has no identity. 0x7fffffff is odd, and Windows pids
    // are always multiples of 4, so it can never name a live process.
    expect(processIdentity(0x7fffffff)).toBeNull()

    // With koffi available, captureBirthTime is the FFI identity.
    expect(captureBirthTime(child.pid!)).toBe(a)
  }, 15_000)

  it('killTreeWin32 with matching birthTime kills the tree', async () => {
    const child = spawnTreeChild()
    const grandchildPid = await releaseGrandchild(child)
    cleanupPids.push(grandchildPid)

    const birth = captureBirthTime(child.pid!)
    expect(birth).not.toBeNull()
    expect(killTreeWin32(child.pid!, birth)).toBe(true)
    await expectGone(child.pid!)
    await expectGone(grandchildPid)
  }, 15_000)

  it('killTreeWin32 with stale birthTime refuses and leaves the tree alive', async () => {
    const child = spawnTreeChild()
    const grandchildPid = await releaseGrandchild(child)
    cleanupPids.push(grandchildPid)

    const birth = captureBirthTime(child.pid!)
    expect(birth).not.toBeNull()
    // A different creation time is the PID-reuse signature: refuse the kill.
    const stale = String(BigInt(birth!) - 1n)
    expect(killTreeWin32(child.pid!, stale)).toBe(false)
    expectAlive(child.pid!)
    expectAlive(grandchildPid)
  }, 15_000)

  it('killTreeWin32 with null birthTime refuses', async () => {
    const child = spawnTreeChild()
    const grandchildPid = await releaseGrandchild(child)
    cleanupPids.push(grandchildPid)

    expect(killTreeWin32(child.pid!, null)).toBe(false)
    expectAlive(child.pid!)
    expectAlive(grandchildPid)
  }, 15_000)
})
