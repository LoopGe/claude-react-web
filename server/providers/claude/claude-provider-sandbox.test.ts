// Verifies the claude provider applies a per-session `sandbox` setting via
// `applyFlagSettings` (the flag-settings layer) after spawn — mirroring how
// `memory` / `autoCompactWindow` are re-applied — instead of passing it as
// `Options.sandbox`. See shared/sandbox.ts for why the settings layer is the
// right vehicle (Options.sandbox.enabled would default failIfUnavailable=true
// and hard-fail the whole session when sandbox deps are missing).

import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = (await importOriginal<Record<string, unknown>>()) as Record<string, unknown>
  return { ...actual, query: queryMock }
})

import { ClaudeProvider } from './claude-provider.js'
import type { SandboxSetting } from '../../../shared/sandbox.js'

function makeProvider() {
  return new ClaudeProvider({ claudeBinary: '/fake/claude' })
}

function fakeQuery() {
  return { applyFlagSettings: vi.fn().mockResolvedValue(undefined) }
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0))
}

describe('ClaudeProvider.createSession sandbox', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('re-applies sandbox via applyFlagSettings post-spawn when opts.sandbox is set', async () => {
    const q = fakeQuery()
    queryMock.mockReturnValue(q)
    const sandbox: SandboxSetting = { enabled: true, autoAllowBashIfSandboxed: false }

    makeProvider().createSession({ id: 's1', sandbox })
    await flush()

    expect(q.applyFlagSettings).toHaveBeenCalledWith({ sandbox })
    expect(q.applyFlagSettings).toHaveBeenCalledTimes(1)
  })

  it('does not applyFlagSettings for sandbox when opts.sandbox is absent', async () => {
    const q = fakeQuery()
    queryMock.mockReturnValue(q)

    makeProvider().createSession({ id: 's2' })
    await flush()

    expect(q.applyFlagSettings).not.toHaveBeenCalledWith({ sandbox: expect.anything() })
  })
})