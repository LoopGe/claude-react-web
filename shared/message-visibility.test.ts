import { describe, expect, it } from 'vitest'
import { shouldHideByDefault } from './message-visibility'

describe('shouldHideByDefault', () => {
  it('hides non-allowlisted system frames', () => {
    expect(shouldHideByDefault({ type: 'system', subtype: 'init' })).toBe(true)
    expect(shouldHideByDefault({ type: 'system', subtype: 'error' })).toBe(false)
  })

  it('hides CLI local-command logs', () => {
    expect(shouldHideByDefault({
      type: 'user',
      message: { content: '<command-name>/model</command-name>' },
    })).toBe(true)
  })

  it('hides payload-less task-notification injections', () => {
    expect(shouldHideByDefault({
      type: 'user',
      message: { content: [{ type: 'text', text: '<task-notification><task-id>t</task-id><status>completed</status></task-notification>' }] },
    })).toBe(true)
  })

  it('keeps ordinary user/assistant messages', () => {
    expect(shouldHideByDefault({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })).toBe(false)
  })
})