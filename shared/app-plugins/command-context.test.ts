import { describe, expect, it } from 'vitest'
import type { PluginCommandContext } from './command-context.js'

describe('PluginCommandContext', () => {
  it('exposes the dialog action id to typed plugin commands', () => {
    const context: PluginCommandContext = {
      source: 'global',
      invocationId: 'invocation-1',
      commandId: 'plugin.command',
      invokedAt: 1,
      actionId: 'confirm',
    }
    expect(context.actionId).toBe('confirm')
  })
})
