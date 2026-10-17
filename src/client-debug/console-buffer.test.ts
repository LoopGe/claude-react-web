// Tests for the always-on console/error capture ring (src/client-debug/console-buffer.ts).
// Runs in happy-dom (default for src/**): the real console object is patched
// and restored around each test via resetConsoleForTests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONSOLE_ARG_CAP,
  CONSOLE_ENTRY_CAP,
  CONSOLE_RING_CAP,
  type ConsoleEntry,
} from '../../shared/client-debug.js'
import {
  installConsoleCapture,
  readConsoleBuffer,
  recordConsoleEntry,
  resetConsoleForTests,
} from './console-buffer'
import { recordCrash } from '../error-capture'

// Native console.log captured at module load — BEFORE any beforeEach patching.
// The passthrough test installs the wrapper while a spy is on console.log, so
// the wrapper's "original" IS the spy; restoring without a pristine reference
// (or letting resetConsoleForTests run after the manual restore) would leave
// the spy installed as console.log for the rest of the file.
const NATIVE_LOG = console.log

beforeEach(() => {
  resetConsoleForTests()
  installConsoleCapture()
})

afterEach(() => {
  resetConsoleForTests()
})

function argsOf(entries: ConsoleEntry[]): string[][] {
  return entries.map((e) => e.args)
}

describe('installConsoleCapture', () => {
  it('captures console.log with level info and passes through to the original', () => {
    // Spy must be in place BEFORE install so the wrapper's passthrough target
    // is the spy; then console.log(...) routes wrapper → record → spy.
    resetConsoleForTests()
    const orig = vi.fn()
    console.log = orig as typeof console.log
    installConsoleCapture()
    try {
      console.log('hello', 42)
      const { entries, total } = readConsoleBuffer({})
      expect(total).toBe(1)
      expect(entries[0]).toMatchObject({ level: 'info', args: ['hello', '42'] })
      expect(entries[0]!.seq).toBeGreaterThan(0)
      expect(entries[0]!.ts).toBeLessThanOrEqual(Date.now())
      expect(orig).toHaveBeenCalledWith('hello', 42)
    } finally {
      // Unpatch FIRST (reset restores the spy — it was in place at install
      // time), then put the pristine native method back.
      resetConsoleForTests()
      console.log = NATIVE_LOG
    }
  })

  it('maps the console methods to their levels, plus trace → debug with a dedicated stack field', () => {
    console.debug('d')
    console.info('i')
    console.log('l')
    console.warn('w')
    console.error('e')
    console.trace('t')
    const levels = readConsoleBuffer({}).entries.map((e) => e.level)
    expect(levels).toEqual(['debug', 'info', 'info', 'warn', 'error', 'debug'])
    const traceEntry = readConsoleBuffer({}).entries.at(-1)!
    expect(traceEntry.args).toEqual(['t']) // stack NOT in args…
    expect(traceEntry.stack).toContain('at ') // …it rides the dedicated field
    // and grep (which joins args only) does NOT match stack text.
    expect(readConsoleBuffer({ grep: 'at ' }).entries).toHaveLength(0)
  })

  it('reports captureEnabled true once installed and false after reset', () => {
    expect(readConsoleBuffer({}).captureEnabled).toBe(true)
    resetConsoleForTests()
    expect(readConsoleBuffer({}).captureEnabled).toBe(false)
    installConsoleCapture()
    expect(readConsoleBuffer({}).captureEnabled).toBe(true)
  })

  it('is idempotent — installing twice does not double-record', () => {
    installConsoleCapture()
    console.warn('once')
    expect(readConsoleBuffer({}).total).toBe(1)
  })

  it('captures uncaught crashes funneled through recordCrash exactly once, via the console.error passthrough', () => {
    const err = new Error('boom')
    recordCrash({ kind: 'uncaught', at: Date.now(), message: 'boom', error: err })
    // recordCrash's own console.error is the single record — the wrapper
    // captures it; no second explicit funnel entry may appear.
    const errorEntries = readConsoleBuffer({ level: 'error' }).entries
    expect(errorEntries).toHaveLength(1)
    const joined = errorEntries[0]!.args.join(' ')
    expect(joined).toContain('uncaught')
    expect(joined).toContain('boom')
  })
})

describe('argument formatting', () => {
  it('JSON-serializes plain objects and arrays', () => {
    console.log({ a: 1 }, [1, 2])
    expect(argsOf(readConsoleBuffer({}).entries)[0]).toEqual(['{"a":1}', '[1,2]'])
  })

  it('formats an Error as name: message plus its stack', () => {
    console.error(new TypeError('nope'))
    const [arg] = argsOf(readConsoleBuffer({}).entries)[0]!
    expect(arg).toContain('TypeError: nope')
    expect(arg).toContain('at ')
  })

  it('truncates oversized args to CONSOLE_ARG_CAP', () => {
    console.log('x'.repeat(CONSOLE_ARG_CAP + 100))
    const [arg] = argsOf(readConsoleBuffer({}).entries)[0]!
    expect(arg.length).toBe(CONSOLE_ARG_CAP + 1) // cap + ellipsis marker
    expect(arg.endsWith('…')).toBe(true)
  })

  it('never throws on hostile args — circular objects fall back', () => {
    const a: Record<string, unknown> = { self: null }
    a.self = a
    const hostile = { get toJSON() { throw new Error('getter bomb') } }
    expect(() => console.log(a, hostile, Symbol('s'), undefined)).not.toThrow()
    const args = argsOf(readConsoleBuffer({}).entries)[0]!
    expect(args).toHaveLength(4)
    expect(args[2]).toContain('Symbol')
    expect(args[3]).toBe('undefined')
  })

  it('caps an entry\'s TOTAL formatted size at CONSOLE_ENTRY_CAP, separators included', () => {
    console.log(...Array.from({ length: 20 }, (_, i) => 'a'.repeat(500) + `#${i}`))
    const entry = readConsoleBuffer({}).entries[0]!
    const joined = entry.args.join(' ')
    expect(entry.args.length).toBeLessThan(20) // trailing args dropped entirely
    expect(joined.length).toBeLessThanOrEqual(CONSOLE_ENTRY_CAP) // separators budgeted
    expect(joined).not.toContain('#19') // the tail never survived
  })
})

describe('ring buffer', () => {
  it('evicts the oldest entries past CONSOLE_RING_CAP and counts them', () => {
    for (let i = 0; i < CONSOLE_RING_CAP + 3; i++) recordConsoleEntry('info', [`m${i}`])
    const { entries, total, dropped } = readConsoleBuffer({})
    expect(total).toBe(CONSOLE_RING_CAP)
    expect(dropped).toBe(3)
    expect(entries[0]!.args[0]).toBe('m3')
    expect(entries.at(-1)!.args[0]).toBe(`m${CONSOLE_RING_CAP + 2}`)
  })
})

describe('readConsoleBuffer filters', () => {
  beforeEach(() => {
    recordConsoleEntry('debug', ['noise'])
    recordConsoleEntry('info', ['User logged in'])
    recordConsoleEntry('warn', ['deprecated API', 'used by Foo'])
    recordConsoleEntry('error', ['fetch failed'])
  })

  it('level is a minimum-severity filter', () => {
    const levels = readConsoleBuffer({ level: 'warn' }).entries.map((e) => e.level)
    expect(levels).toEqual(['warn', 'error'])
  })

  it('grep is case-insensitive over the joined args', () => {
    const hits = readConsoleBuffer({ grep: 'USER LOGGED' }).entries
    expect(hits).toHaveLength(1)
    expect(hits[0]!.args[0]).toBe('User logged in')
  })

  it('since is a ts >= filter', () => {
    const future = Date.now() + 60_000
    expect(readConsoleBuffer({ since: future }).entries).toHaveLength(0)
    expect(readConsoleBuffer({ since: 0 }).entries).toHaveLength(4)
  })

  it('limit keeps the NEWEST N of the filtered entries', () => {
    const entries = readConsoleBuffer({ limit: 2 }).entries
    expect(entries.map((e) => e.level)).toEqual(['warn', 'error'])
  })

  it('filters AND together and reports pre-filter total and dropped', () => {
    const res = readConsoleBuffer({ level: 'info', grep: 'fetch' })
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0]!.level).toBe('error')
    expect(res.total).toBe(4)
    expect(res.dropped).toBe(0)
  })

  it('seq is monotonic across entries', () => {
    const seqs = readConsoleBuffer({}).entries.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })
})
