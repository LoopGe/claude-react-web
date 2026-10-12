import { describe, expect, it } from 'vitest'
import { toSdkHooksSettings, validateSessionHooksConfig } from './hooks.js'

describe('hooks config validation', () => {
  it('normalizes supported command and http hooks', () => {
    const result = validateSessionHooksConfig({
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: 'echo "$CLAUDE_TOOL_NAME"',
              shell: 'bash',
              timeout: 5,
              statusMessage: 'Checking tool',
              async: true,
              asyncRewake: true,
            },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'http',
              url: 'https://example.com/hook',
              headers: { Authorization: 'Bearer $TOKEN' },
              allowedEnvVars: ['TOKEN'],
            },
          ],
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.PreToolUse?.[0]?.hooks[0]).toMatchObject({
      type: 'command',
      command: 'echo "$CLAUDE_TOOL_NAME"',
      shell: 'bash',
      async: true,
    })
    expect(toSdkHooksSettings(result.value)).toEqual(result.value)
  })

  it('rejects unsupported events and hook types', () => {
    const result = validateSessionHooksConfig({
      UnknownEvent: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
      PreToolUse: [{ hooks: [{ type: 'function' }] }],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((e) => e.path)).toEqual(['UnknownEvent', 'PreToolUse[0].hooks[0].type'])
  })

  it('normalizes onFailure (SDK 0.3.295) on every hook type and forwards it verbatim to SDK settings', () => {
    const result = validateSessionHooksConfig({
      PreToolUse: [{
        hooks: [
          { type: 'command', command: 'strict', onFailure: 'block' },
          { type: 'http', url: 'https://example.com/h', onFailure: 'continue' },
        ],
      }],
      UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'check', onFailure: 'block' }] }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.PreToolUse?.[0]?.hooks[0]).toMatchObject({ type: 'command', onFailure: 'block' })
    expect(result.value.PreToolUse?.[0]?.hooks[1]).toMatchObject({ type: 'http', onFailure: 'continue' })
    expect(result.value.UserPromptSubmit?.[0]?.hooks[0]).toMatchObject({ type: 'prompt', onFailure: 'block' })
    // toSdkHooksSettings spreads the whole hook — onFailure must survive.
    expect(toSdkHooksSettings(result.value).PreToolUse).toEqual(result.value.PreToolUse)
  })

  it('rejects an unknown onFailure value', () => {
    const result = validateSessionHooksConfig({
      PreToolUse: [{ hooks: [{ type: 'command', command: 'x', onFailure: 'maybe' }] }],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toEqual([
      { path: 'PreToolUse[0].hooks[0].onFailure', message: 'must be "continue" or "block"' },
    ])
  })

  it('normalizes prompt and agent hooks for Claude Code parity', () => {
    const result = validateSessionHooksConfig({
      Stop: [{ hooks: [{ type: 'prompt', prompt: 'Summarize $ARGUMENTS', model: 'claude-haiku' }] }],
      PermissionRequest: [{ hooks: [{ type: 'agent', prompt: 'Verify the request', timeout: 30 }] }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.Stop?.[0]?.hooks[0]).toMatchObject({
      type: 'prompt',
      prompt: 'Summarize $ARGUMENTS',
      model: 'claude-haiku',
    })
    expect(result.value.PermissionRequest?.[0]?.hooks[0]).toMatchObject({
      type: 'agent',
      prompt: 'Verify the request',
      timeout: 30,
    })
  })

  it('rejects malformed http URLs and header values', () => {
    const result = validateSessionHooksConfig({
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'http',
              url: 'file:///tmp/hook',
              headers: { ok: 'yes', bad: 123 },
              allowedEnvVars: ['TOKEN', 123],
            },
          ],
        },
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((e) => e.path)).toEqual([
      'UserPromptSubmit[0].hooks[0].url',
      'UserPromptSubmit[0].hooks[0].headers.bad',
      'UserPromptSubmit[0].hooks[0].allowedEnvVars[1]',
    ])
  })
})
