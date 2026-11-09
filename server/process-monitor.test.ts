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

/** Race `promise` against a timeout so a hung promise fails the test fast
 *  instead of waiting for vitest's global limit. */
function expectSettled<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`promise did not settle within ${ms}ms`)), ms),
    ),
  ])
}

function expectExitSoon(reg: MonitoredSpawn, ms = 3000): Promise<ProcessExitInfo> {
  return expectSettled(reg.exited, ms)
}

function expectRealExitSoon(reg: MonitoredSpawn, ms = 3000): Promise<ProcessExitInfo> {
  return expectSettled(reg.realExited, ms)
}

/** Poll until `process.kill(pid, 0)` throws — the process (or group) is gone. */
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

/** SpawnOptions for a child that spawns its own sleeping grandchild, prints
 *  the grandchild's pid to stdout, then stays alive. With `ignoreSigterm`
 *  both processes trap SIGTERM, so only a group SIGKILL can stop them. The
 *  grandchild is spawned WITHOUT detached, so it shares the child's process
 *  group — a group signal reaches both; a single-PID kill does not. */
function treeSpawnOpts(ignoreSigterm: boolean): SpawnOptions {
  const trap = ignoreSigterm ? `process.on('SIGTERM',()=>{});` : ''
  const grandchild = trap + 'setInterval(()=>{},1000)'
  const script =
    `const {spawn}=require('child_process');` +
    `const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});` +
    `console.log(c.pid);` +
    trap +
    `setInterval(()=>{},1000)`
  return {
    command: process.execPath,
    args: ['-e', script],
    env: { ...process.env } as SpawnOptions['env'],
    signal: new AbortController().signal,
  }
}

/** Read the first stdout line of the spawned child (the grandchild's pid). */
function firstStdoutLine(p: SpawnedProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const stdout = (p as unknown as { stdout: NodeJS.ReadableStream }).stdout
    stdout.setEncoding?.('utf8')
    let buf = ''
    const onChunk = (chunk: string | Buffer) => {
      buf += String(chunk)
      const idx = buf.indexOf('\n')
      if (idx >= 0) {
        stdout.off('data', onChunk)
        resolve(Number.parseInt(buf.slice(0, idx).trim(), 10))
      }
    }
    stdout.on('data', onChunk)
    setTimeout(() => reject(new Error('child printed no pid within 2s')), 2000)
  })
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

  it('refuses a stray spawn after a real exit removed the registration', async () => {
    const onExit = vi.fn()
    const mon = new ProcessMonitor(onExit)
    const reg = mon.register('s-unregistered')

    mon.spawnFor(reg, spawnOpts(0))
    await expectExitSoon(reg, 1000)

    expect(() => mon.spawnFor(reg, spawnOpts(0))).toThrow(/unregistered/i)
    expect(onExit).toHaveBeenCalledTimes(1)
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
    const stderr = (proc as unknown as { stderr: NodeJS.EventEmitter }).stderr
    const endBefore = stderr.listenerCount('end')
    mon.unregister(reg) // intentional close — must NOT surface via onExit

    // No real 'exit' arrives, so the unregister-armed timer must resolve
    // `exited` (so clear()'s respawn gate can't hang) without surfacing.
    const info = await expectExitSoon(reg, 500)
    expect(info.code).toBeNull()
    expect(onExit).not.toHaveBeenCalled()
    expect(stderr.listenerCount('data')).toBe(0)
    expect(stderr.listenerCount('end')).toBe(endBefore - 1)

    // Tear down the still-alive child so the test process can exit cleanly.
    ;(proc as unknown as { kill: () => boolean }).kill()
    await new Promise((r) => setTimeout(r, 30))
  })

  // New contract: the safety timer no longer merely gives up waiting — it
  // escalates (SIGTERM tree, then SIGKILL tree). A SIGTERM-ignoring child
  // therefore survives the first leg (realExited stays pending), and the
  // escalation leg's SIGKILL actually kills it, so realExited settles with
  // the SIGKILL signal instead of waiting for external cleanup.
  it.runIf(process.platform !== 'win32')('safety timer escalates: realExited stays pending past SIGTERM and settles on the SIGKILL leg', async () => {
    const mon = new ProcessMonitor(() => {}, { safetyMs: 50, escalateMs: 400 })
    const reg = mon.register('s-late-exit')

    // A child that traps SIGTERM (100s sleeper would otherwise die on the
    // first escalation leg). It only dies on the SIGKILL leg.
    const script =
      `process.on('SIGTERM',()=>{});` +
      `setInterval(()=>{},1000)`
    const proc = mon.spawnFor(reg, {
      command: process.execPath,
      args: ['-e', script],
      env: { ...process.env } as SpawnOptions['env'],
      signal: new AbortController().signal,
    })
    try {
      mon.unregister(reg)
      const safety = await expectExitSoon(reg, 500)
      expect(safety.exitSafetyTimeout).toBe(true)

      // Mid-window: past the SIGTERM leg (50ms), well before the SIGKILL leg
      // (450ms) — margins are wide on both sides so scheduler drift on a
      // loaded runner cannot flip the assertion.
      await new Promise((r) => setTimeout(r, 200))
      let realSettled = false
      void reg.realExited.then(() => { realSettled = true })
      expect(realSettled).toBe(false)

      const info = await expectRealExitSoon(reg)
      expect(info.signal).toBe('SIGKILL')
      expect(realSettled).toBe(true)
    } finally {
      ;(proc as unknown as { kill: (s?: NodeJS.Signals) => boolean }).kill('SIGKILL')
    }
  })

  it('refuses a deferred process that arrives after intentional unregister', async () => {
    const mon = new ProcessMonitor(() => {})
    const reg = mon.register('s-deferred-spawn')
    mon.unregister(reg)

    expect(() => mon.spawnFor(reg, spawnOpts(0, 100_000))).toThrow(/unregister|closed|intentional/i)
  })

  it('refuses another spawn while an intentional entry is still closing', async () => {
    const mon = new ProcessMonitor(() => {})
    const reg = mon.register('s-still-closing')
    const proc = mon.spawnFor(reg, spawnOpts(0, 100_000))
    try {
      mon.unregister(reg)
      expect(() => mon.spawnFor(reg, spawnOpts(0, 100_000))).toThrow(/unregister|closed|intentional/i)
    } finally {
      ;(proc as unknown as { kill: () => boolean }).kill()
    }
  })

  it('calls stderrSink with session id and each captured stderr line', async () => {
    const sink = vi.fn()
    const mon = new ProcessMonitor(() => {}, { stderrSink: sink })
    const reg = mon.register('s-stderr-sink')

    // Spawn a child that writes two lines to stderr then exits.
    const opts: SpawnOptions = {
      command: process.execPath,
      args: ['-e', 'process.stderr.write("line-a\\nline-b\\n"); process.exit(0)'],
      env: { ...process.env } as SpawnOptions['env'],
      signal: new AbortController().signal,
    }
    mon.spawnFor(reg, opts)
    await expectExitSoon(reg)

    // Give the data/end handlers a tick to flush.
    await new Promise((r) => setTimeout(r, 50))
    expect(sink).toHaveBeenCalledWith('s-stderr-sink', 'line-a')
    expect(sink).toHaveBeenCalledWith('s-stderr-sink', 'line-b')
  })

  // ---- subprocess-tree containment (detached PGID) ----
  // The monitor owns the spawn, so it can place the CLI in its own process
  // group (detached: true on POSIX). Every teardown signal then reaches the
  // whole tree via the negative-PGID group signal instead of only the direct
  // child — the DSH subprocess-local containment model.

  it.runIf(process.platform !== 'win32')('spawns the CLI detached: the child leads its own process group', async () => {
    const mon = new ProcessMonitor(() => {})
    const reg = mon.register('s-detached')

    const proc = mon.spawnFor(reg, spawnOpts(0, 100_000))
    const pid = (proc as unknown as { pid: number }).pid
    try {
      // Signal 0 is an existence probe; -pid addresses the GROUP whose leader
      // is pid. Before the detached-spawn change the child shared our group
      // and was not a leader, so this threw ESRCH.
      expect(() => process.kill(-pid, 0)).not.toThrow()
    } finally {
      ;(proc as unknown as { kill: (s?: NodeJS.Signals) => boolean }).kill('SIGKILL')
      await new Promise((r) => setTimeout(r, 30))
    }
  })

  it.runIf(process.platform !== 'win32')('destroy escalation SIGTERMs the whole tree when the child wedges', async () => {
    const onExit = vi.fn()
    const mon = new ProcessMonitor(onExit, { safetyMs: 60 })
    const reg = mon.register('s-tree-term')

    const proc = mon.spawnFor(reg, treeSpawnOpts(false))
    let grandPid = 0
    try {
      grandPid = await firstStdoutLine(proc)
      mon.unregister(reg)

      // The safety timer fires the group SIGTERM; parent (and grandchild, which
      // shares the group) both die. realExited resolves with the real signal.
      const info = await expectRealExitSoon(reg)
      expect(info.signal).toBe('SIGTERM')
      await expectGone(grandPid)
      // Intentional close: surfaced to neither onExit.
      expect(onExit).not.toHaveBeenCalled()
    } finally {
      // Test-hygiene backstop: if the escalation ever regresses, don't leak
      // 100s sleepers into the developer's process table. Direct kills on
      // both pids — grandPid is NOT a group leader (the direct child is), so
      // a negative-pid kill would miss it with ESRCH.
      ;(proc as unknown as { kill: (s?: NodeJS.Signals) => boolean }).kill('SIGKILL')
      if (grandPid > 0) {
        try { process.kill(grandPid, 'SIGKILL') } catch { /* already gone */ }
      }
    }
    void proc
  })

  it.runIf(process.platform !== 'win32')('escalates to SIGKILL for the whole tree when SIGTERM is ignored', async () => {
    const mon = new ProcessMonitor(() => {}, { safetyMs: 60, escalateMs: 80 })
    const reg = mon.register('s-tree-kill')

    const proc = mon.spawnFor(reg, treeSpawnOpts(true))
    let grandPid = 0
    try {
      grandPid = await firstStdoutLine(proc)
      mon.unregister(reg)

      // Both processes trap SIGTERM, so only the escalation leg's group SIGKILL
      // can stop them. realExited carries the SIGKILL signal.
      const info = await expectRealExitSoon(reg)
      expect(info.signal).toBe('SIGKILL')
      await expectGone(grandPid)
    } finally {
      ;(proc as unknown as { kill: (s?: NodeJS.Signals) => boolean }).kill('SIGKILL')
      if (grandPid > 0) {
        try { process.kill(grandPid, 'SIGKILL') } catch { /* already gone */ }
      }
    }
    void proc
  })

  it.runIf(process.platform !== 'win32')('finalization sweeps leftover group-mates when the CLI dies first', async () => {
    const onExit = vi.fn()
    const mon = new ProcessMonitor(onExit)
    const reg = mon.register('s-finalize-sweep')

    // The direct child spawns a sleeping grandchild (same group) and exits
    // immediately — the exact shape of a CLI crash leaving its foreground
    // descendants behind. Finalization must probe the group and SIGTERM the
    // leftover members; otherwise they reparent and run forever. The explicit
    // process.exit(0) is required: a live ChildProcess handle keeps the
    // spawning parent's event loop alive, so without it the "crashed CLI"
    // would itself never exit.
    const script =
      `const {spawn}=require('child_process');` +
      `const c=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:'ignore'});` +
      `console.log(c.pid);` +
      `process.exit(0);`
    let grandPid = 0
    const proc = mon.spawnFor(reg, {
      command: process.execPath,
      args: ['-e', script],
      env: { ...process.env } as SpawnOptions['env'],
      signal: new AbortController().signal,
    })
    try {
      grandPid = await firstStdoutLine(proc)
      await expectExitSoon(reg)
      await expectGone(grandPid)
    } finally {
      ;(proc as unknown as { kill: (s?: NodeJS.Signals) => boolean }).kill('SIGKILL')
      if (grandPid > 0) {
        try { process.kill(grandPid, 'SIGKILL') } catch { /* already gone */ }
      }
    }
  })

  it.runIf(process.platform !== 'win32')('finalization does NOT sweep group-mates after an intentional destroy', async () => {
    // An intentionally destroyed CLI has already run its own graceful
    // shutdown; whatever it leaves in its group may be an intentionally
    // backgrounded service (`nohup server &`), which must survive. Only
    // UNINTENTIONAL exits (crashes) sweep leftover group-mates.
    const mon = new ProcessMonitor(() => {}, { safetyMs: 5_000 })
    const reg = mon.register('s-finalize-keep')

    const script =
      `const {spawn}=require('child_process');` +
      `const c=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:'ignore'});` +
      `console.log(c.pid);` +
      `process.exit(0);`
    let grandPid = 0
    const proc = mon.spawnFor(reg, {
      command: process.execPath,
      args: ['-e', script],
      env: { ...process.env } as SpawnOptions['env'],
      signal: new AbortController().signal,
    })
    try {
      grandPid = await firstStdoutLine(proc)
      mon.unregister(reg) // intentional destroy BEFORE the child exits
      await expectExitSoon(reg) // the "crashed-free" CLI exit finalizes
      await new Promise((r) => setTimeout(r, 300))
      // The leftover grandchild must still be alive: the sweep is
      // crash-only, and this exit was intentional.
      expect(() => process.kill(grandPid, 0)).not.toThrow()
    } finally {
      ;(proc as unknown as { kill: (s?: NodeJS.Signals) => boolean }).kill('SIGKILL')
      if (grandPid > 0) {
        try { process.kill(grandPid, 'SIGKILL') } catch { /* already gone */ }
      }
    }
  })

  it('removes its exit-sweep registration once every tracked tree has settled', async () => {
    const mon = new ProcessMonitor(() => {})
    const reg = mon.register('s-sweep-release')

    mon.spawnFor(reg, spawnOpts(0))
    expect((mon as unknown as { sweepRegistered: boolean }).sweepRegistered).toBe(true)

    await expectExitSoon(reg)
    // Last entry finalized: the monitor must release its module-level sweep
    // registration so a retired monitor is not retained for the process
    // lifetime (tests construct many; a future second production monitor
    // must not pin its predecessor).
    expect((mon as unknown as { sweepRegistered: boolean }).sweepRegistered).toBe(false)
  })

  it('registers exactly one process-exit sweep hook and its sweep signals every live tree', async () => {
    const onExit = vi.fn()
    const mon = new ProcessMonitor(onExit)
    const listenersBefore = process.listenerCount('exit')
    const reg = mon.register('s-exit-sweep')

    mon.spawnFor(reg, spawnOpts(0, 100_000))
    // The hook is installed lazily on the process's FIRST spawn and never
    // again — earlier tests in this file may have installed it already, so
    // the count either stays put or moves by exactly one.
    const afterFirst = process.listenerCount('exit')
    expect(afterFirst).toBeGreaterThanOrEqual(Math.max(listenersBefore, 1))
    expect(afterFirst).toBeLessThanOrEqual(listenersBefore + 1)

    // A second monitor spawning must not add a second hook.
    const mon2 = new ProcessMonitor(() => {})
    const reg2 = mon2.register('s-exit-sweep-2')
    mon2.spawnFor(reg2, spawnOpts(0, 100_000))
    expect(process.listenerCount('exit')).toBe(afterFirst)

    // The sweep is the hook's body: synchronous, signals each live tree.
    const proc = (mon as unknown as { entries: Map<MonitoredSpawn, { process: { pid: number } | null }> })
      .entries.get(reg)?.process
    expect(proc?.pid).toBeGreaterThan(0)
    mon.sweepForProcessExit()

    await expectExitSoon(reg)
    expect(onExit.mock.calls[0][0]).toMatchObject({ sessionId: 's-exit-sweep', signal: 'SIGTERM' })
  })
})
