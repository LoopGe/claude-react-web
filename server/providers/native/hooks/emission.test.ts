// Task 5: the neutral hook/run OperationalFrame and its host SDK projection.
// The core emits hook activity as a neutral frame; the adapter projects it to
// the exact system/hook_started|hook_progress|hook_response shape the pump's
// hookLifecycleMessage already parses (zero pump/UI change). Two pins:
//   • projection — each kind maps to the right SDK subtype/fields, optional
//     output fields appear only when present, the envelope rides inline.
//   • round-trip — projecting then parsing through the REAL pump parser
//     reconstructs the neutral runtime event, proving the field names (notably
//     the snake_case exit_code) match what the pump reads.

import { describe, expect, it } from 'vitest'
import type { HookRunRecord, HookRuntimeEvent } from '../../../../shared/hooks.js'
import type { OperationalFrame } from '../vocabulary/live-frame.js'
import { projectNativeEventToSdk } from '../../native-host-frame-adapter.js'
import { hookLifecycleMessage } from '../../../session-pump.js'

const SESSION = 's'
const UUID = 'u'

function frame(event: HookRuntimeEvent, parentToolUseId: string | null = null): OperationalFrame {
  return { type: 'hook/run', event, sessionId: SESSION, uuid: UUID, parentToolUseId }
}

function run(overrides: Partial<HookRunRecord> & Pick<HookRunRecord, 'status'>): HookRunRecord {
  return {
    id: 'h1',
    hookId: 'h1',
    hookName: 'PreToolUse',
    event: 'PreToolUse',
    startedAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** The pump stamps startedAt/updatedAt from Date.now(), so the round-trip
 *  compares the durable run facts only (identity, status, output, exit code). */
function runFacts(record: HookRunRecord): Omit<HookRunRecord, 'startedAt' | 'updatedAt'> {
  const { startedAt: _s, updatedAt: _u, ...rest } = record
  return rest
}

function project(event: HookRuntimeEvent, parentToolUseId: string | null = null): Record<string, unknown> {
  const projected = projectNativeEventToSdk(frame(event, parentToolUseId))
  expect(projected).not.toBeNull()
  return projected as Record<string, unknown>
}

describe('hook/run projection — SDK system/hook_* shape', () => {
  it('started → hook_started with hook_id/hook_name/hook_event + inline envelope', () => {
    const event: HookRuntimeEvent = { kind: 'started', run: run({ status: 'started' }) }
    expect(project(event)).toEqual({
      type: 'system',
      subtype: 'hook_started',
      session_id: SESSION,
      uuid: UUID,
      parent_tool_use_id: null,
      hook_id: 'h1',
      hook_name: 'PreToolUse',
      hook_event: 'PreToolUse',
    })
  })

  it('progress → hook_progress, no outcome', () => {
    const event: HookRuntimeEvent = { kind: 'progress', run: run({ status: 'progress', output: 'partial' }) }
    const projected = project(event)
    expect(projected.subtype).toBe('hook_progress')
    expect(projected.output).toBe('partial')
    expect('outcome' in projected).toBe(false)
  })

  it('completed success with exitCode → hook_response, outcome success, exit_code copied', () => {
    const event: HookRuntimeEvent = {
      kind: 'completed',
      run: run({ id: 'h2', hookId: 'h2', hookName: 'audit', event: 'PostToolUse', status: 'success', startedAt: 1, updatedAt: 2, stdout: 'out', stderr: 'err', output: 'parsed', exitCode: 0 }),
    }
    expect(project(event)).toEqual({
      type: 'system',
      subtype: 'hook_response',
      session_id: SESSION,
      uuid: UUID,
      parent_tool_use_id: null,
      hook_id: 'h2',
      hook_name: 'audit',
      hook_event: 'PostToolUse',
      stdout: 'out',
      stderr: 'err',
      output: 'parsed',
      exit_code: 0,
      outcome: 'success',
    })
  })

  it('completed error → outcome error; completed cancelled → outcome cancelled', () => {
    const error = project({ kind: 'completed', run: run({ status: 'error', exitCode: 2, stderr: 'blocked' }) })
    expect(error.subtype).toBe('hook_response')
    expect(error.outcome).toBe('error')
    expect(error.exit_code).toBe(2)
    expect(error.stderr).toBe('blocked')

    const cancelled = project({ kind: 'completed', run: run({ status: 'cancelled' }) })
    expect(cancelled.subtype).toBe('hook_response')
    expect(cancelled.outcome).toBe('cancelled')
    expect('exit_code' in cancelled).toBe(false)
  })

  it('omits absent optional output fields; outcome rides only on hook_response', () => {
    const started = project({ kind: 'started', run: run({ status: 'started' }) })
    for (const key of ['stdout', 'stderr', 'output', 'exit_code', 'outcome']) {
      expect(key in started).toBe(false)
    }
    const completed = project({ kind: 'completed', run: run({ status: 'success' }) })
    for (const key of ['stdout', 'stderr', 'output', 'exit_code']) {
      expect(key in completed).toBe(false)
    }
    expect(completed.outcome).toBe('success')
  })

  it('carries a sidechain parent verbatim on the envelope', () => {
    const projected = project({ kind: 'started', run: run({ status: 'started' }) }, 'tu-parent')
    expect(projected.parent_tool_use_id).toBe('tu-parent')
  })

  it('a completed run with a non-terminal status is a loud contract violation', () => {
    expect(() => project({ kind: 'completed', run: run({ status: 'started' }) })).toThrow()
  })
})

describe('hook/run round-trip through the real pump parser (zero pump change)', () => {
  const cases: Array<{ name: string; event: HookRuntimeEvent }> = [
    { name: 'started', event: { kind: 'started', run: run({ status: 'started' }) } },
    { name: 'progress', event: { kind: 'progress', run: run({ status: 'progress', output: 'partial' }) } },
    {
      name: 'completed success',
      event: { kind: 'completed', run: run({ status: 'success', stdout: 'out', stderr: 'err', output: 'parsed', exitCode: 0 }) },
    },
    { name: 'completed error', event: { kind: 'completed', run: run({ status: 'error', exitCode: 2, stderr: 'blocked' }) } },
    { name: 'completed cancelled', event: { kind: 'completed', run: run({ status: 'cancelled' }) } },
  ]

  for (const { name, event } of cases) {
    it(`reconstructs the neutral runtime event: ${name}`, () => {
      const projected = projectNativeEventToSdk(frame(event))
      expect(projected).not.toBeNull()
      const parsed = hookLifecycleMessage(projected as Parameters<typeof hookLifecycleMessage>[0])
      expect(parsed).not.toBeNull()
      expect(parsed!.kind).toBe(event.kind)
      expect(runFacts(parsed!.run)).toEqual(runFacts(event.run))
    })
  }
})
