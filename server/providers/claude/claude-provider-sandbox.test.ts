// Verifies the claude provider applies a per-session `sandbox` setting via
// `applyFlagSettings` (the flag-settings layer) after spawn — mirroring how
// `memory` / `autoCompactWindow` are re-applied — instead of passing it as
// `Options.sandbox`. See shared/sandbox.ts for why the settings layer is the
// right vehicle (Options.sandbox.enabled would default failIfUnavailable=true
// and hard-fail the whole session when sandbox deps are missing).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

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

  it('injects in-process hooks into sdkOptions when inProcessHookForward is provided', async () => {
    const q = fakeQuery()
    queryMock.mockReturnValue(q)

    makeProvider().createSession({ id: 's3', inProcessHookForward: vi.fn() })
    await flush()

    const options = queryMock.mock.calls[0]?.[0]?.options as { hooks?: unknown }
    expect(options?.hooks).toBeDefined()
    expect((options?.hooks as Record<string, unknown>).Stop).toBeDefined()
  })

  it('does not inject hooks when inProcessHookForward is absent', async () => {
    const q = fakeQuery()
    queryMock.mockReturnValue(q)

    makeProvider().createSession({ id: 's4' })
    await flush()

    const options = queryMock.mock.calls[0]?.[0]?.options as { hooks?: unknown }
    expect(options?.hooks).toBeUndefined()
  })
})

describe('ClaudeProvider.createSession cliDebug', () => {
  const tmpDirs: string[] = []
  beforeEach(() => {
    queryMock.mockReset()
  })
  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
    tmpDirs.length = 0
  })

  it('sets debug=true and debugFile when cliDebug is true', async () => {
    const q = fakeQuery()
    queryMock.mockReturnValue(q)
    const tmpLogsDir = mkdtempSync(join(tmpdir(), 'cw-cli-debug-'))
    tmpDirs.push(tmpLogsDir)

    new ClaudeProvider({ claudeBinary: '/fake/claude', logsDir: tmpLogsDir }).createSession({ id: 'sess-1', cliDebug: true } as never)
    await flush()

    const options = queryMock.mock.calls[0]?.[0]?.options as Options & { debug?: boolean; debugFile?: string }
    expect(options.debug).toBe(true)
    expect(options.debugFile).toMatch(/cli-sess-1\.log$/)
  })

  it('leaves debug undefined when cliDebug is false', async () => {
    const q = fakeQuery()
    queryMock.mockReturnValue(q)

    makeProvider().createSession({ id: 'sess-2', cliDebug: false } as never)
    await flush()

    const options = queryMock.mock.calls[0]?.[0]?.options as Options & { debug?: boolean; debugFile?: string }
    expect(options.debug).toBeUndefined()
    expect(options.debugFile).toBeUndefined()
  })

  it('leaves debug undefined when cliDebug is absent', async () => {
    const q = fakeQuery()
    queryMock.mockReturnValue(q)

    makeProvider().createSession({ id: 'sess-3' })
    await flush()

    const options = queryMock.mock.calls[0]?.[0]?.options as Options & { debug?: boolean; debugFile?: string }
    expect(options.debug).toBeUndefined()
    expect(options.debugFile).toBeUndefined()
  })
})