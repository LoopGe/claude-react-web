// server/providers/native/hooks/output.test.ts
import { describe, it, expect } from 'vitest'
import { parseHookOutput, applyOnFailure } from './output.js'
import type { HookExecResult } from './output.js'
import type { HookConfig } from '../../../../shared/hooks.js'

const cmd: HookConfig = { type: 'command', command: 'echo hi' }
const cmdBlock: HookConfig = { type: 'command', command: 'echo hi', onFailure: 'block' }
const cmdContinue: HookConfig = { type: 'command', command: 'echo hi', onFailure: 'continue' }
const cmdAsyncBlock: HookConfig = { type: 'command', command: 'echo hi', async: true, onFailure: 'block' }
const cmdRewakeBlock: HookConfig = { type: 'command', command: 'echo hi', asyncRewake: true, onFailure: 'block' }
const httpBlock: HookConfig = { type: 'http', url: 'https://example.com/hook', onFailure: 'block' }
const promptBlock: HookConfig = { type: 'prompt', prompt: 'check this', onFailure: 'block' }
const agentBlock: HookConfig = { type: 'agent', prompt: 'check this', onFailure: 'block' }

const errorResult: HookExecResult = { outcome: 'error', exitCode: 1, stdout: '', stderr: 'boom' }

describe('parseHookOutput — stdout parse (RS §2.2)', () => {
  it('plain text (does not start with {) → success, no decision', () => {
    const r = parseHookOutput('plain', '', 0, cmd)
    expect(r.outcome).toBe('success')
    expect(r.stdout).toBe('plain')
    expect(r.decision).toBeUndefined()
    expect(r.async).toBeUndefined()
  })

  it('empty stdout → success plain text, no decision', () => {
    const r = parseHookOutput('', '', 0, cmd)
    expect(r.outcome).toBe('success')
    expect(r.decision).toBeUndefined()
  })

  it('sync JSON decision block + reason is parsed', () => {
    const r = parseHookOutput('{"decision":"block","reason":"no"}', '', 0, cmd)
    expect(r.outcome).toBe('success')
    expect(r.decision?.decision).toBe('block')
    expect(r.decision?.reason).toBe('no')
  })

  it('{"continue":false} is parsed', () => {
    const r = parseHookOutput('{"continue":false}', '', 0, cmd)
    expect(r.outcome).toBe('success')
    expect(r.decision?.continue).toBe(false)
  })

  it('trims whitespace before the { check and before parsing', () => {
    const r = parseHookOutput('  {"continue":false}  ', '', 0, cmd)
    expect(r.outcome).toBe('success')
    expect(r.decision?.continue).toBe(false)
  })

  it('{"async":true} → async true', () => {
    const r = parseHookOutput('{"async":true}', '', 0, cmd)
    expect(r.outcome).toBe('success')
    expect(r.async).toBe(true)
    expect(r.decision).toBeUndefined()
  })

  it('{"async":true,"asyncTimeout":5000} → async true', () => {
    const r = parseHookOutput('{"async":true,"asyncTimeout":5000}', '', 0, cmd)
    expect(r.async).toBe(true)
  })

  it('{"async":false} is NOT async (sync no-op after strip)', () => {
    const r = parseHookOutput('{"async":false}', '', 0, cmd)
    expect(r.async).toBeUndefined()
    expect(r.outcome).toBe('success')
  })

  it('empty JSON object {} → success, empty decision', () => {
    const r = parseHookOutput('{}', '', 0, cmd)
    expect(r.outcome).toBe('success')
    expect(r.decision).toEqual({})
  })

  it('unknown keys are stripped (zod strip), not a validation failure', () => {
    const r = parseHookOutput('{"totallyUnknown":1}', '', 0, cmd)
    expect(r.outcome).toBe('success')
    expect(r.decision).toEqual({})
  })

  it('all ten whitelist fields are recognized and kept', () => {
    const stdout = JSON.stringify({
      continue: true,
      suppressOutput: false,
      stopReason: 'sr',
      decision: 'approve',
      reason: 'r',
      systemMessage: 'sm',
      terminalSequence: 'ts',
      metrics: { a: 1, b: true },
      rewakeSummary: 'rs',
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'ctx' },
    })
    const r = parseHookOutput(stdout, '', 0, cmd)
    expect(r.outcome).toBe('success')
    expect(r.decision).toEqual({
      continue: true,
      suppressOutput: false,
      stopReason: 'sr',
      decision: 'approve',
      reason: 'r',
      systemMessage: 'sm',
      terminalSequence: 'ts',
      metrics: { a: 1, b: true },
      rewakeSummary: 'rs',
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'ctx' },
    })
  })

  // Review Focus 2 — invalid JSON starting with { must degrade to plain text
  // and NEVER throw. A }-terminated malformed object is a reported error.
  it('}-terminated invalid JSON → error, plain text, never throws', () => {
    let r: HookExecResult | undefined
    expect(() => { r = parseHookOutput('{bad json}', '', 0, cmd) }).not.toThrow()
    expect(r!.outcome).toBe('error')
    expect(r!.stdout).toBe('{bad json}')
    expect(r!.decision).toBeUndefined()
  })

  it('schema validation failure (wrong type) → error, plain text, never throws', () => {
    let r: HookExecResult | undefined
    expect(() => { r = parseHookOutput('{"continue":"not-a-bool"}', '', 0, cmd) }).not.toThrow()
    expect(r!.outcome).toBe('error')
    expect(r!.decision).toBeUndefined()
  })

  it('invalid decision enum → error', () => {
    const r = parseHookOutput('{"decision":"maybe"}', '', 0, cmd)
    expect(r.outcome).toBe('error')
  })

  it('non-object hookSpecificOutput → error', () => {
    const r = parseHookOutput('{"hookSpecificOutput":"notobject"}', '', 0, cmd)
    expect(r.outcome).toBe('error')
  })

  // CLI-faithful nuance (RS §2.2 step 4, zY catch `!n.endsWith("}")`): a
  // {-starting string that does NOT end with } is "not a JSON object" and is
  // treated as plain text WITHOUT a validationError → success at exit 0. The
  // brief's literal '{bad json' → error example conflicts with this; see the
  // task report (controller adjudication requested). The error-on-invalid-JSON
  // intent of Review Focus 2 is pinned by the }-terminated case above.
  it('{-starting text not ending with } → plain text success (CLI zY catch branch)', () => {
    let r: HookExecResult | undefined
    expect(() => { r = parseHookOutput('{bad json', '', 0, cmd) }).not.toThrow()
    expect(r!.outcome).toBe('success')
    expect(r!.stdout).toBe('{bad json')
    expect(r!.decision).toBeUndefined()
  })

  it('JSON lines of no-ops → plain text success (CLI Avr branch)', () => {
    const r = parseHookOutput('{}\n{}', '', 0, cmd)
    expect(r.outcome).toBe('success')
    expect(r.decision).toBeUndefined()
  })

  it('JSON lines with a real decision → error (not all no-ops)', () => {
    const r = parseHookOutput('{"decision":"block","reason":"x"}\n{}', '', 0, cmd)
    expect(r.outcome).toBe('error')
  })
})

describe('parseHookOutput — exit codes (RS §2.3)', () => {
  it('exit 0 → success', () => {
    expect(parseHookOutput('plain', '', 0, cmd).outcome).toBe('success')
  })

  it('exit 2 → blocked, stderr is the block message', () => {
    const r = parseHookOutput('plain', 'blocked because', 2, cmd)
    expect(r.outcome).toBe('blocked')
    expect(r.stderr).toBe('blocked because')
  })

  it('exit 3 → non-blocking error', () => {
    const r = parseHookOutput('plain', 'some stderr', 3, cmd)
    expect(r.outcome).toBe('error')
    expect(r.exitCode).toBe(3)
  })

  it('exit 1 → non-blocking error', () => {
    expect(parseHookOutput('', 'err', 1, cmd).outcome).toBe('error')
  })

  it('JSON block reason overrides stderr on exit 2', () => {
    const r = parseHookOutput('{"decision":"block","reason":"json reason"}', 'raw stderr', 2, cmd)
    expect(r.outcome).toBe('blocked')
    expect(r.stderr).toBe('json reason')
  })

  it('exit 2 with decision block but no reason falls back to stderr', () => {
    const r = parseHookOutput('{"decision":"block"}', 'raw stderr', 2, cmd)
    expect(r.outcome).toBe('blocked')
    expect(r.stderr).toBe('raw stderr')
  })

  it('exit 2 overrides permissionDecision:"allow"', () => {
    const stdout = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
    const r = parseHookOutput(stdout, 'raw stderr', 2, cmd)
    expect(r.outcome).toBe('blocked')
  })

  it('exit 2 with decision approve still blocks (exit 2 wins)', () => {
    const r = parseHookOutput('{"decision":"approve"}', 'raw stderr', 2, cmd)
    expect(r.outcome).toBe('blocked')
    expect(r.stderr).toBe('raw stderr')
  })

  it('exit 0 with invalid JSON → error (not success)', () => {
    const r = parseHookOutput('{"continue":"bad"}', '', 0, cmd)
    expect(r.outcome).toBe('error')
  })

  it('exit 2 with invalid JSON → blocked (exit 2 wins over parse error)', () => {
    const r = parseHookOutput('{"continue":"bad"}', 'raw stderr', 2, cmd)
    expect(r.outcome).toBe('blocked')
    expect(r.stderr).toBe('raw stderr')
  })
})

describe('applyOnFailure (RS §2.4)', () => {
  it('command non-async + onFailure:block rewrites error → blocked', () => {
    const r = applyOnFailure(cmdBlock, errorResult)
    expect(r.outcome).toBe('blocked')
  })

  it('http + onFailure:block rewrites error → blocked', () => {
    const r = applyOnFailure(httpBlock, errorResult)
    expect(r.outcome).toBe('blocked')
  })

  it('command async:true is exempt (unchanged)', () => {
    const r = applyOnFailure(cmdAsyncBlock, errorResult)
    expect(r.outcome).toBe('error')
    expect(r).toEqual(errorResult)
  })

  it('command asyncRewake:true is exempt (unchanged)', () => {
    const r = applyOnFailure(cmdRewakeBlock, errorResult)
    expect(r.outcome).toBe('error')
  })

  it('prompt is exempt (unchanged)', () => {
    const r = applyOnFailure(promptBlock, errorResult)
    expect(r.outcome).toBe('error')
    expect(r).toEqual(errorResult)
  })

  it('agent is exempt (unchanged)', () => {
    const r = applyOnFailure(agentBlock, errorResult)
    expect(r.outcome).toBe('error')
  })

  it('onFailure:continue is exempt (unchanged)', () => {
    const r = applyOnFailure(cmdContinue, errorResult)
    expect(r.outcome).toBe('error')
  })

  it('no onFailure is exempt (unchanged)', () => {
    const r = applyOnFailure(cmd, errorResult)
    expect(r.outcome).toBe('error')
  })

  it('a success result is never rewritten', () => {
    const success: HookExecResult = { outcome: 'success', exitCode: 0, stdout: 'ok', stderr: '' }
    expect(applyOnFailure(cmdBlock, success).outcome).toBe('success')
  })

  it('an already-blocked result is never rewritten', () => {
    const blocked: HookExecResult = { outcome: 'blocked', exitCode: 2, stdout: '', stderr: 'no' }
    const r = applyOnFailure(cmdBlock, blocked)
    expect(r.outcome).toBe('blocked')
    expect(r.stderr).toBe('no')
  })

  it('a cancelled (timeout) result is rewritten to blocked with a timed-out message', () => {
    const cancelled: HookExecResult = { outcome: 'cancelled', stdout: '', stderr: '' }
    const r = applyOnFailure(cmdBlock, cancelled)
    expect(r.outcome).toBe('blocked')
    expect(r.stderr).toContain('timed out')
  })

  it('the rewrite message names onFailure block and keeps the failure detail', () => {
    const r = applyOnFailure(cmdBlock, errorResult)
    expect(r.stderr).toContain('onFailure')
    expect(r.stderr).toContain('boom')
  })
})
