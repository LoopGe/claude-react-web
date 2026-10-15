import { describe, expect, it, vi } from 'vitest'
import { SupplementSession, formatSupplementInstruction } from './steering.js'

const open = (s: SupplementSession) => s.notePromptConsumed()

describe('SupplementSession admission', () => {
  it('rejects enqueue before any prompt is consumed and after an empty Stop', () => {
    const s = new SupplementSession(vi.fn())
    expect(s.enqueue({ uuid: 'a', text: 'x' })).toBe(false) // 初始 closed
    open(s)
    expect(s.enqueue({ uuid: 'a', text: 'x' })).toBe(true)
    s.handleBoundary('PreToolUse', {}) // 先投递 'a'，让 pending 清空
    expect(s.handleBoundary('Stop', {})).toEqual({}) // 空 Stop
    expect(s.enqueue({ uuid: 'b', text: 'y' })).toBe(false) // 已关
    open(s) // 下一轮 prompt 读取重开
    expect(s.enqueue({ uuid: 'b', text: 'y' })).toBe(true)
  })
  it('empty Stop closes admission but a Stop WITH pending keeps it open', () => {
    const s = new SupplementSession(vi.fn())
    open(s)
    s.enqueue({ uuid: 'a', text: 'x' })
    expect(s.handleBoundary('Stop', {})).toEqual({ decision: 'block', reason: expect.stringContaining('x') })
    expect(s.enqueue({ uuid: 'b', text: 'y' })).toBe(true) // block 续跑 → 保持开
  })
})

describe('SupplementSession delivery', () => {
  it('PreToolUse drains all pending as one additionalContext and fires onDelivered', () => {
    const onDelivered = vi.fn()
    const s = new SupplementSession(onDelivered)
    open(s)
    s.enqueue({ uuid: 'a', text: 'one' })
    s.enqueue({ uuid: 'b', text: 'two' })
    const out = s.handleBoundary('PreToolUse', {})
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: expect.stringContaining('one\n\ntwo'),
      },
    })
    expect(onDelivered).toHaveBeenCalledWith('a', { ok: true, boundary: 'PreToolUse' })
    expect(onDelivered).toHaveBeenCalledWith('b', { ok: true, boundary: 'PreToolUse' })
    expect(s.drainUndelivered()).toEqual([]) // 已清空
  })
  it('ignores subagent-inherited hooks: agent_id set → {} and pending preserved', () => {
    const onDelivered = vi.fn()
    const s = new SupplementSession(onDelivered)
    open(s)
    s.enqueue({ uuid: 'a', text: 'one' })
    expect(s.handleBoundary('PreToolUse', { agent_id: 'agent-1' })).toEqual({})
    expect(onDelivered).not.toHaveBeenCalled()
    expect(s.drainUndelivered()).toEqual([{ uuid: 'a' }]) // pending 未动
  })
  it('drainUndelivered returns and clears; abort reports aborted outcome', () => {
    const onDelivered = vi.fn()
    const s = new SupplementSession(onDelivered)
    open(s)
    s.enqueue({ uuid: 'a', text: 'one' })
    expect(s.drainUndelivered()).toEqual([{ uuid: 'a' }])
    s.enqueue({ uuid: 'b', text: 'two' })
    s.abort()
    expect(onDelivered).toHaveBeenCalledWith('b', { ok: false, reason: 'aborted' })
  })
})

describe('formatSupplementInstruction', () => {
  it('wraps user text with the four guidance rules', () => {
    const out = formatSupplementInstruction('use python not bash')
    expect(out).toContain('[ADDITIONAL GUIDANCE]')
    expect(out).toContain('use python not bash')
    expect(out).toContain('Preserve and complete the original objective.')
    expect(out).toContain('Do not send a separate acknowledgement.')
  })
})
