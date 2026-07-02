import { describe, expect, it, vi } from 'vitest'
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { ProcessMonitor, type MonitoredSpawn, type ProcessExitInfo } from './process-monitor.js'

// The monitor's spawnFor returns the SDK's SpawnedProcess type (only 'exit' /
// 'error' declared), but the underlying object is a Node ChildProcess. Cast
// through unknown for the few ChildProcess-only fields tests inspect.
type Childish = NodeJS.EventEmitter & { killed: boolean; exitCode: number | null }
function asChild(p: SpawnedProcess): Childish {
  return p as unknown as Childish
}

/** Build SpawnOptions for a trivial Node subprocess that exits with `code`
 *  after an optional delay. Real child processes exercise the same 'spawn' /
 *  'exit' lifecycle the CLI does, without depending on the claude binary. */
function spawnOpts(code: number, delayMs = 0): SpawnOptions {
  const script =
    delayMs > 0
      ? `setTimeout(() => process.exit(${code}), ${delayMs})`
      : `process.exit(${code})`
  return {
    command: process.execPath,
    args: ['-e', script],
    env: { ...process.env } as SpawnOptions['env'],
    // SpawnOptions.signal is required by the SDK type; the monitor ignores it
    // (correlation is closure-based), so an never-aborted signal is fine.
    signal: new AbortController().signal,
  }
}

/** Race `reg.exited` against a timeout so a hung promise fails the test fast
 *  instead of waiting for vitest's global limit. */
function expectExitSoon(reg: MonitoredSpawn, ms = 3000): Promise<ProcessExitInfo> {
  return Promise.race([
    reg.exited,
    new Promise<ProcessExitInfo>((_, reject) =>
      setTimeout(() => reject(new Error(`exited did not resolve within ${ms}ms`)), ms),
    ),
  ])
}

describe('ProcessMonitor', () => {
  it('exited resolves with the real exit code and fires onExit', async () => {
    const onExit = vi.fn()
    const mon = new ProcessMonitor(onExit)
    const reg = mon.register('s-exit-0')

    const proc = mon.spawnFor(reg, spawnOpts(0))
    const info = await expectExitSoon(reg)

    expect(info.code).toBe(0)
    expect(info.sessionId).toBe('s-exit-0')
    expect(info.killed).toBe(false)
    expect(asChild(proc).exitCode).toBe(0)
    // Non-intentional exit surfaces to the SessionManager.
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit.mock.calls[0][0]).toMatchObject({ sessionId: 's-exit-0', code: 0 })
  })

  it('onExit carries a non-zero crash code', async () => {
    const onExit = vi.fn()
    const mon = new ProcessMonitor(onExit)
    const reg = mon.register('s-crash')

    mon.spawnFor(reg, spawnOpts(2))
    const info = await expectExitSoon(reg)

    expect(info.code).toBe(2)
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit.mock.calls[0][0]).toMatchObject({ sessionId: 's-crash', code: 2 })
  })

  it('spawned flag is false until spawnFor and true after', () => {
    const mon = new ProcessMonitor(() => {})
    const reg = mon.register('s-flag')
    expect(reg.spawned).toBe(false)
    expect(reg.intentional).toBe(false)

    mon.spawnFor(reg, spawnOpts(0))

    expect(reg.spawned).toBe(true)
  })

  it('unregister before any spawn resolves exited immediately (no hang, no onExit)', async () => {
    const onExit = vi.fn()
    const mon = new ProcessMonitor(onExit)
    const reg = mon.register('s-no-spawn')

    mon.unregister(reg)

    const info = await expectExitSoon(reg, 1500)
    expect(info.sessionId).toBe('s-no-spawn')
    expect(info.code).toBeNull()
    // No real process ran, so there is nothing to surface.
    expect(onExit).not.toHaveBeenCalled()
  })

  it('does not fire onExit for an intentional exit after unregister (spawned)', async () => {
    const onExit = vi.fn()
    const mon = new ProcessMonitor(onExit)
    const reg = mon.register('s-intentional')

    // Long-lived child so we can unregister (simulate destroy()) BEFORE it
    // exits, then observe the real exit resolves `exited` without surfacing.
    const proc = mon.spawnFor(reg, spawnOpts(0, 150))
    mon.unregister(reg)
    expect(reg.intentional).toBe(true)

    const info = await expectExitSoon(reg)
    expect(info.code).toBe(0)
    // Intentional close: the SessionManager tore it down on purpose, so the
    // exit must NOT be reported (clear/auto-resume/unload drive their own
    // lifecycle; a second handleProcessExit would double-broadcast).
    expect(onExit).not.toHaveBeenCalled()
    void proc
  })

  it('spawn for an unregistered handle still spawns (no throw) and is not tracked', async () => {
    const onExit = vi.fn()
    const mon = new ProcessMonitor(onExit)
    const reg = mon.register('s-unregistered')

    // Simulate the destroy() path: unregister marks intentional and (since
    // nothing spawned yet) resolves exited + deletes the entry.
    mon.unregister(reg)
    await expectExitSoon(reg, 1000)

    // A stray spawn AFTER unregister must not throw and must not fire onExit.
    const proc = mon.spawnFor(reg, spawnOpts(0))
    await new Promise((r) => asChild(proc).on('exit', r))
    // Give the exit handler a tick to run.
    await new Promise((r) => setTimeout(r, 20))
    expect(onExit).not.toHaveBeenCalled()
  })

  // Regression: the EXIT_SAFETY_MS backstop timer must NOT be armed at spawn.
  // An earlier revision armed it in spawnFor, so any healthy session that lived
  // longer than 15s (its CLI process alive, 'exit' never coming) was torn down
  // as a false "CLI process exited unexpectedly (code=null, signal=null)" and
  // the still-alive child was orphaned. The timer now arms only at unregister.
  it('does not arm a spawn-time safety timer: a healthy long-running session is not torn down', async () => {
    const onExit = vi.fn()
    // 50ms safety window so we don't wait 15s. The bug armed this at spawn, so
    // onExit would fire ~50ms in with code=null — the assertion below catches that.
    const mon = new ProcessMonitor(onExit, { safetyMs: 50 })
    const reg = mon.register('s-healthy')

    // Long-lived child (300ms) so NO real 'exit' arrives during the test and no
    // unregister is called (the session is still "alive" from the monitor's view).
    mon.spawnFor(reg, spawnOpts(0, 300))

    // Well past the 50ms safety window. Before the fix, onExit had already
    // fired here with { code: null, signal: null } and resolved `exited`.
    await new Promise((r) => setTimeout(r, 150))
    expect(onExit).not.toHaveBeenCalled()

    // The real exit eventually surfaces normally once the child actually exits.
    const info = await expectExitSoon(reg)
    expect(info.code).toBe(0)
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  // Regression: spawnFor attaches 'data'/'end' listeners to child.stderr for
  // diagnostic logging, but finalizeEntry only detached the 'exit'/'error'
  // handlers. The stderr listeners (and the `buf` closure they capture) stayed
  // attached to the ChildProcess until it was GC'd, retaining potentially
  // large stderr strings and the monitor's closures. finalizeEntry must detach
  // them so a dead ChildProcess reference can't keep the monitor alive.
  //
  // Node's Readable adds its own internal 'end' listener once the stream
  // enters flowing mode (via our 'data' listener), so we assert the monitor's
  // handlers were removed by checking the count drops by exactly one for each
  // event — robust to however many internal listeners Node keeps.
  it('detaches stderr listeners after the process exits (no closure leak)', async () => {
    const onExit = vi.fn()
    const mon = new ProcessMonitor(onExit)
    const reg = mon.register('s-stderr-leak')

    const proc = mon.spawnFor(reg, spawnOpts(0))
    const stderr = (proc as unknown as { stderr: NodeJS.EventEmitter }).stderr
    const dataBefore = stderr.listenerCount('data')
    const endBefore = stderr.listenerCount('end')
    expect(dataBefore).toBeGreaterThanOrEqual(1)
    expect(endBefore).toBeGreaterThanOrEqual(1)

    // Wait for exit + finalizeEntry (reg.exited resolves inside finalize).
    await expectExitSoon(reg)

    // The monitor's own 'data' and 'end' handlers must be gone. 'data' has no
    // internal listener, so it reaches 0; 'end' keeps Node's internal one, so
    // it drops by exactly 1.
    expect(stderr.listenerCount('data')).toBe(0)
    expect(stderr.listenerCount('end')).toBe(endBefore - 1)
  })

  it('safety timer armed at unregister resolves exited when the child never emits exit (no onExit)', async () => {
    const onExit = vi.fn()
    const mon = new ProcessMonitor(onExit, { safetyMs: 50 })
    const reg = mon.register('s-wedged')

    // A child that will not exit on its own during the test (long sleeper).
    const proc = mon.spawnFor(reg, spawnOpts(0, 100_000))
    mon.unregister(reg) // intentional close — must NOT surface via onExit

    // No real 'exit' arrives, so the unregister-armed timer must resolve
    // `exited` (so clear()'s respawn gate can't hang) without surfacing.
    const info = await expectExitSoon(reg, 500)
    expect(info.code).toBeNull()
    expect(onExit).not.toHaveBeenCalled()

    // Tear down the still-alive child so the test process can exit cleanly.
    ;(proc as unknown as { kill: () => boolean }).kill()
    await new Promise((r) => setTimeout(r, 30))
  })
})
