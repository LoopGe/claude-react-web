import { describe, expect, it, vi } from 'vitest'
import { buildInProcessHooks, capHookInput } from './inprocess-hooks.js'
import type { InProcessHookForward } from './inprocess-hooks.js'

describe('buildInProcessHooks', () => {
  it('registers a Stop hook matcher', () => {
    const hooks = buildInProcessHooks()
    expect((hooks as Record<string, unknown>).Stop).toBeDefined()
  })

  it('Stop callback forwards an inproc record with transcript_path', async () => {
    const forward = vi.fn()
    const hooks = buildInProcessHooks(forward as InProcessHookForward)
    const matchers = (hooks as Record<string, unknown>).Stop as { hooks: Array<(input: any) => Promise<unknown>> }[]
    const cb = matchers[0].hooks[0]
    const input = { session_id: 's1', transcript_path: '/tmp/t.json' }
    await cb(input)
    expect(forward).toHaveBeenCalledTimes(1)
    const [sid, event] = (forward as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(sid).toBe('s1')
    expect(event.kind).toBe('completed')
    expect(event.run.hookId).toBeTruthy()
    expect(event.run.hookName).toBe('inproc:Stop')
    expect(event.run.event).toBe('Stop')
    expect(event.run.hookInput).toContain('transcript_path')
  })

  it('does not forward when session_id is missing', async () => {
    const forward = vi.fn()
    const hooks = buildInProcessHooks(forward as InProcessHookForward)
    const matchers = (hooks as Record<string, unknown>).Stop as { hooks: Array<(input: any) => Promise<unknown>> }[]
    await matchers[0].hooks[0]({ transcript_path: '/tmp/t.json' })
    expect(forward).not.toHaveBeenCalled()
  })

  it('does not forward when no forward is provided', async () => {
    const hooks = buildInProcessHooks()
    const matchers = (hooks as Record<string, unknown>).Stop as { hooks: Array<(input: any) => Promise<unknown>> }[]
    await expect(matchers[0].hooks[0]({ session_id: 's1', transcript_path: '/tmp/t.json' })).resolves.toBeUndefined()
  })

  it('defensiveHook swallows a throwing inner callback instead of rejecting', async () => {
    const forward = vi.fn()
    const hooks = buildInProcessHooks(forward as InProcessHookForward)
    // Force a bad input shape that the callback mishandles: non-object input.
    const matchers = (hooks as Record<string, unknown>).Stop as { hooks: Array<(input: any, toolUseID?: string, deps?: unknown) => Promise<unknown>> }[]
    await expect(matchers[0].hooks[0](null)).resolves.not.toThrow()
    // Default options object is used when the SDK omits it.
    await expect(matchers[0].hooks[0]({ session_id: 's1', transcript_path: '/tmp/t.json' }, 'tid', undefined)).resolves.not.toThrow()
  })
})

describe('capHookInput', () => {
  it('caps a long string and preserves the head', () => {
    const s = 'a'.repeat(1000)
    const out = capHookInput(s, 100)
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out.startsWith('a'.repeat(80))).toBe(true) // head preserved, truncation marker
  })

  it('returns short strings unchanged', () => {
    expect(capHookInput('hi', 100)).toBe('hi')
  })
})