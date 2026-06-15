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
