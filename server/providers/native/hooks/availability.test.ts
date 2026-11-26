// server/providers/native/hooks/availability.test.ts
import { describe, it, expect } from 'vitest'
import { checkAvailability } from './availability.js'
import { resolveHookModel, DEFAULT_SMALL_FAST_MODEL } from './model.js'
import { SUPPORTED_HOOK_EVENTS } from '../../../../shared/hooks.js'

// The RS §12.2 availability matrix: the REAL gates (context / REPL), not the
// stale "tool events only" help text. Reason strings mirror the CLI wording
// (extracted from the pinned binary). ok:false is a NON-BLOCKING error result
// (Review Focus 4) — never a throw, never silent success.

describe('checkAvailability', () => {
  describe('no-conversation-context events (Review Focus 4)', () => {
    it('prompt on SessionStart without context → non-blocking error', () => {
      const r = checkAvailability('prompt', 'SessionStart', false)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('no conversation context is available')
    })

    it('agent on SessionStart without context → non-blocking error', () => {
      const r = checkAvailability('agent', 'SessionStart', false)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('no conversation context is available')
    })

    it('prompt/agent on SubagentStart without context → error', () => {
      expect(checkAvailability('prompt', 'SubagentStart', false).ok).toBe(false)
      expect(checkAvailability('agent', 'SubagentStart', false).ok).toBe(false)
    })

    it('prompt/agent on Setup without context → error', () => {
      expect(checkAvailability('prompt', 'Setup', false).ok).toBe(false)
      expect(checkAvailability('agent', 'Setup', false).ok).toBe(false)
    })

    it('does NOT throw and does NOT silently succeed on a no-context event', () => {
      expect(() => checkAvailability('prompt', 'SessionStart', false)).not.toThrow()
      expect(() => checkAvailability('agent', 'SubagentStart', false)).not.toThrow()
      expect(checkAvailability('prompt', 'SessionStart', false).ok).not.toBe(true)
    })
  })

  describe('agent explicitly rejected on PermissionRequest', () => {
    it('agent on PermissionRequest (even with context) → error', () => {
      const r = checkAvailability('agent', 'PermissionRequest', true)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toContain('cannot return the allow / deny decision')
        expect(r.reason).toContain('PermissionRequest')
      }
    })

    it('prompt on PermissionRequest with context → ok (prompt IS allowed)', () => {
      expect(checkAvailability('prompt', 'PermissionRequest', true).ok).toBe(true)
    })
  })

  describe('non-REPL events → "not yet supported outside REPL"', () => {
    it('prompt on PreCompact → error', () => {
      const r = checkAvailability('prompt', 'PreCompact', false)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('not yet supported outside REPL')
    })

    it('agent on PreCompact → error', () => {
      expect(checkAvailability('agent', 'PreCompact', false).ok).toBe(false)
    })

    it('PostCompact / StopFailure / SessionEnd → error for both types', () => {
      for (const event of ['PostCompact', 'StopFailure', 'SessionEnd'] as const) {
        expect(checkAvailability('prompt', event, false).ok).toBe(false)
        expect(checkAvailability('agent', event, false).ok).toBe(false)
      }
    })

    it('the rest of the non-REPL tier → error (RS §12.2 lN row)', () => {
      const nonRepl = [
        'ConfigChange',
        'Notification',
        'Elicitation',
        'ElicitationResult',
        'CwdChanged',
        'FileChanged',
        'InstructionsLoaded',
        'WorktreeCreate',
        'WorktreeRemove',
      ] as const
      for (const event of nonRepl) {
        expect(checkAvailability('prompt', event, true).ok).toBe(false)
        expect(checkAvailability('agent', event, true).ok).toBe(false)
      }
    })

    it('non-REPL gate is structural — fires even when hasContext is true', () => {
      const r = checkAvailability('prompt', 'PreCompact', true)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('not yet supported outside REPL')
    })
  })

  describe('supported events WITH context → ok', () => {
    it('prompt on Stop → ok', () => {
      expect(checkAvailability('prompt', 'Stop', true).ok).toBe(true)
    })

    it('agent on PreToolUse → ok', () => {
      expect(checkAvailability('agent', 'PreToolUse', true).ok).toBe(true)
    })

    it('Stop / SubagentStop / UserPromptSubmit support both types', () => {
      for (const event of ['Stop', 'SubagentStop', 'UserPromptSubmit'] as const) {
        expect(checkAvailability('prompt', event, true).ok).toBe(true)
        expect(checkAvailability('agent', event, true).ok).toBe(true)
      }
    })

    it('the tool events support both types', () => {
      for (const event of [
        'PreToolUse',
        'PostToolUse',
        'PostToolUseFailure',
        'PermissionDenied',
      ] as const) {
        expect(checkAvailability('prompt', event, true).ok).toBe(true)
        expect(checkAvailability('agent', event, true).ok).toBe(true)
      }
    })

    it('TaskCreated / TaskCompleted / TeammateIdle with context → ok', () => {
      for (const event of ['TaskCreated', 'TaskCompleted', 'TeammateIdle'] as const) {
        expect(checkAvailability('prompt', event, true).ok).toBe(true)
        expect(checkAvailability('agent', event, true).ok).toBe(true)
      }
    })
  })

  describe('context gate is keyed on hasContext, not the event name', () => {
    it('a normally-supported event dispatched WITHOUT context → error', () => {
      const r = checkAvailability('prompt', 'Stop', false)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('no conversation context is available')
    })
  })

  describe('exact CLI reason wording', () => {
    it('prompt no-context interpolates the event name', () => {
      const r = checkAvailability('prompt', 'SessionStart', false)
      expect(r).toEqual({
        ok: false,
        reason:
          'prompt-type hooks are not supported for SessionStart events (no conversation context is available). Use a command-type hook instead.',
      })
    })

    it('agent no-context interpolates the event name', () => {
      const r = checkAvailability('agent', 'SubagentStart', false)
      expect(r).toEqual({
        ok: false,
        reason:
          'agent-type hooks are not supported for SubagentStart events (no conversation context is available). Use a command-type hook instead.',
      })
    })

    it('agent PermissionRequest rejection matches the CLI string', () => {
      const r = checkAvailability('agent', 'PermissionRequest', true)
      expect(r).toEqual({
        ok: false,
        reason:
          'agent-type hooks are not supported for PermissionRequest events (an agent hook answers ok or not ok, and cannot return the allow / deny decision a permission request needs). Use a command- or http-type hook instead.',
      })
    })

    it('non-REPL prompt/agent use the distinct CLI strings', () => {
      expect(checkAvailability('prompt', 'SessionEnd', false)).toEqual({
        ok: false,
        reason: 'Prompt stop hooks are not yet supported outside REPL',
      })
      expect(checkAvailability('agent', 'SessionEnd', false)).toEqual({
        ok: false,
        reason: 'Agent stop hooks are not yet supported outside REPL',
      })
    })

    it('ok result carries no reason', () => {
      expect(checkAvailability('prompt', 'Stop', true)).toEqual({ ok: true })
    })
  })

  it('every supported event yields a defined result (no crash on any event)', () => {
    for (const event of SUPPORTED_HOOK_EVENTS) {
      for (const type of ['prompt', 'agent'] as const) {
        for (const hasContext of [true, false]) {
          const r = checkAvailability(type, event, hasContext)
          expect(typeof r.ok).toBe('boolean')
          if (!r.ok) expect(typeof r.reason).toBe('string')
        }
      }
    }
  })
})

describe('resolveHookModel', () => {
  it('configured (per-hook model) wins over everything', () => {
    expect(
      resolveHookModel({
        configured: 'my-model',
        smallFastEnv: 'env-model',
        sessionModel: 'sess-model',
        gateway: false,
      }),
    ).toBe('my-model')
  })

  it('configured wins even on a gateway (no fallback when set)', () => {
    expect(
      resolveHookModel({ configured: 'my-model', sessionModel: 'sess-model', gateway: true }),
    ).toBe('my-model')
  })

  it('smallFastEnv is used when no configured model', () => {
    expect(
      resolveHookModel({ smallFastEnv: 'env-model', sessionModel: 'sess-model', gateway: false }),
    ).toBe('env-model')
  })

  it('smallFastEnv beats the gateway fallback (env present → no fallback)', () => {
    expect(
      resolveHookModel({ smallFastEnv: 'env-model', sessionModel: 'sess-model', gateway: true }),
    ).toBe('env-model')
  })

  it('falls back to the Haiku-class default when nothing is configured', () => {
    expect(resolveHookModel({ sessionModel: 'sess-model', gateway: false })).toBe(
      DEFAULT_SMALL_FAST_MODEL,
    )
    expect(DEFAULT_SMALL_FAST_MODEL).toBe('claude-haiku-5-5')
  })

  it('agent gateway fallback → sessionModel when no small-fast configured', () => {
    expect(resolveHookModel({ sessionModel: 'sess-model', gateway: true })).toBe('sess-model')
  })

  it('the default is a small-fast id, NOT the session main model', () => {
    const resolved = resolveHookModel({ sessionModel: 'claude-opus-4-6', gateway: false })
    expect(resolved).not.toBe('claude-opus-4-6')
    expect(resolved).toBe('claude-haiku-5-5')
  })
})
