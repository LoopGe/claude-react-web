import { describe, it, expect } from 'vitest'
import { planAttachGlobalMcpServer, planDetachGlobalMcpServer } from './mcp-attach.js'

describe('planAttachGlobalMcpServer', () => {
  it('adds to an own-list session and stamps', () => {
    expect(planAttachGlobalMcpServer({ sessionNames: ['a'], runtimeNames: ['a'], globalEnabledNames: ['a', 'b'], name: 'b' }))
      .toEqual({ names: ['a', 'b'], stampNames: true, alreadyAttached: false })
  })

  it('does not pin an inheriting session', () => {
    expect(planAttachGlobalMcpServer({ sessionNames: undefined, runtimeNames: [], globalEnabledNames: ['a'], name: 'b' }))
      .toEqual({ names: ['a', 'b'], stampNames: false, alreadyAttached: false })
  })

  it('is idempotent only when the name is live on the session', () => {
    expect(planAttachGlobalMcpServer({ sessionNames: ['a'], runtimeNames: ['a'], globalEnabledNames: ['a'], name: 'a' }).alreadyAttached).toBe(true)
    // Globally enabled but added after spawn → not live → must attach.
    expect(planAttachGlobalMcpServer({ sessionNames: undefined, runtimeNames: [], globalEnabledNames: ['a'], name: 'a' }).alreadyAttached).toBe(false)
  })
})

describe('planDetachGlobalMcpServer', () => {
  it('removes from an own-list session and keeps the stamp', () => {
    expect(planDetachGlobalMcpServer({ sessionNames: ['a', 'b'], runtimeNames: ['a', 'b'], globalEnabledNames: ['a', 'b'], name: 'b' }))
      .toEqual({ names: ['a'], stampNames: true, alreadyAttached: true })
  })

  it('removes from an inheriting session without stamping', () => {
    expect(planDetachGlobalMcpServer({ sessionNames: undefined, runtimeNames: ['a', 'b'], globalEnabledNames: ['a', 'b'], name: 'b' }))
      .toEqual({ names: ['a'], stampNames: false, alreadyAttached: true })
  })
})