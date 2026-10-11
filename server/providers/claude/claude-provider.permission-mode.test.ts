// Verifies the spawn path PINS the SDK permission mode instead of omitting it.
//
// SDK 0.3.286 redefined an omitted `Options.permissionMode` as "leave it to
// Claude Code", which would bypass this app's canUseTool broker (settings
// defaultMode applies; third-party providers start in auto mode whose
// classifier decides before canUseTool). The canonical rationale lives next
// to SDK_FORWARDED_PERMISSION_MODES in server/permission-modes.ts — these
// tests pin the wire-level contract only.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = (await importOriginal<Record<string, unknown>>()) as Record<string, unknown>
  return { ...actual, query: queryMock }
})

import { ClaudeProvider } from './claude-provider.js'
import type { CreateSessionOptions } from '../types.js'

function makeProvider() {
  return new ClaudeProvider({ claudeBinary: '/fake/claude' })
}

function fakeQuery() {
  return { applyFlagSettings: vi.fn().mockResolvedValue(undefined) }
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0))
}

function spawnedOptions() {
  return queryMock.mock.calls[0]?.[0]?.options as { permissionMode?: string }
}

describe('ClaudeProvider.createSession spawn permission mode', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it("pins 'default' when no mode is requested", async () => {
    queryMock.mockReturnValue(fakeQuery())
    makeProvider().createSession({ id: 'pm-1' } as CreateSessionOptions)
    await flush()
    expect(spawnedOptions().permissionMode).toBe('default')
  })

  it("pins 'default' for app-side broker modes (acceptEdits)", async () => {
    queryMock.mockReturnValue(fakeQuery())
    makeProvider().createSession({ id: 'pm-2', permissionMode: 'acceptEdits' } as CreateSessionOptions)
    await flush()
    expect(spawnedOptions().permissionMode).toBe('default')
  })

  it("pins 'default' for bypassPermissions (broker-enforced app-side)", async () => {
    queryMock.mockReturnValue(fakeQuery())
    makeProvider().createSession({ id: 'pm-3', permissionMode: 'bypassPermissions' } as CreateSessionOptions)
    await flush()
    expect(spawnedOptions().permissionMode).toBe('default')
  })

  it("pins 'default' for dontAsk (broker-enforced app-side)", async () => {
    queryMock.mockReturnValue(fakeQuery())
    makeProvider().createSession({ id: 'pm-4', permissionMode: 'dontAsk' } as CreateSessionOptions)
    await flush()
    expect(spawnedOptions().permissionMode).toBe('default')
  })

  it("forwards 'plan' verbatim (CLI-side plan steering)", async () => {
    queryMock.mockReturnValue(fakeQuery())
    makeProvider().createSession({ id: 'pm-5', permissionMode: 'plan' } as CreateSessionOptions)
    await flush()
    expect(spawnedOptions().permissionMode).toBe('plan')
  })

  it("forwards 'auto' verbatim (CLI native auto-mode classifier)", async () => {
    queryMock.mockReturnValue(fakeQuery())
    makeProvider().createSession({ id: 'pm-6', permissionMode: 'auto' } as CreateSessionOptions)
    await flush()
    expect(spawnedOptions().permissionMode).toBe('auto')
  })
})
