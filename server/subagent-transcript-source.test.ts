import { describe, expect, it, vi } from 'vitest'
import { HttpError } from './errors.js'
import type { AgentProvider } from './providers/types.js'
import type { SubagentTranscriptSub } from './subagent-transcript-hub.js'
import {
  ProviderSubagentTranscriptHub,
  type SubagentTranscriptSource,
} from './subagent-transcript-source.js'

function provider(name: string): AgentProvider {
  return { name } as AgentProvider
}

function source(name: string): SubagentTranscriptSource & {
  calls: Array<{ sessionId: string; agentId: string }>
  sub: SubagentTranscriptSub
  close: () => void
} {
  const calls: Array<{ sessionId: string; agentId: string }> = []
  const sub: SubagentTranscriptSub = {
    iterable: (async function* () { yield { sessionId: name, agentId: name, reset: true, frames: [] } })(),
    unsubscribe: () => {},
  }
  return {
    calls,
    sub,
    subscribeSubagentTranscript(sessionId, agentId) {
      calls.push({ sessionId, agentId })
      return sub
    },
    close: vi.fn(),
  }
}

describe('ProviderSubagentTranscriptHub', () => {
  it('resolves each session and selects the matching provider source', () => {
    const claude = source('claude')
    const native = source('native')
    const resolveProvider = vi.fn((sessionId: string) => provider(sessionId === 'native-session' ? 'native' : 'claude'))
    const hub = new ProviderSubagentTranscriptHub({ resolveProvider, claude, native })

    expect(hub.subscribeSubagentTranscript('claude-session', 'agent-1')).toBe(claude.sub)
    expect(hub.subscribeSubagentTranscript('native-session', 'agent-2')).toBe(native.sub)
    expect(claude.calls).toEqual([{ sessionId: 'claude-session', agentId: 'agent-1' }])
    expect(native.calls).toEqual([{ sessionId: 'native-session', agentId: 'agent-2' }])
    expect(resolveProvider).toHaveBeenNthCalledWith(1, 'claude-session')
    expect(resolveProvider).toHaveBeenNthCalledWith(2, 'native-session')
  })

  it('preserves resolver capability errors instead of falling back to another source', () => {
    const claude = source('claude')
    const native = source('native')
    const failure = new HttpError(501, 'provider native does not support subagent transcripts')
    const hub = new ProviderSubagentTranscriptHub({
      resolveProvider: () => { throw failure },
      claude,
      native,
    })

    expect(() => hub.subscribeSubagentTranscript('native-session', 'agent-1')).toThrow(failure)
    expect(claude.calls).toEqual([])
    expect(native.calls).toEqual([])
  })

  it('rejects a provider with no registered source explicitly', () => {
    const hub = new ProviderSubagentTranscriptHub({
      resolveProvider: () => provider('other'),
      claude: source('claude'),
      native: source('native'),
    })

    expect(() => hub.subscribeSubagentTranscript('other-session', 'agent-1')).toThrowError(
      expect.objectContaining({ status: 501, message: 'provider other does not support subagent transcript streaming' }),
    )
  })

  it('closes every provider source', () => {
    const claude = source('claude')
    const native = source('native')
    const hub = new ProviderSubagentTranscriptHub({ resolveProvider: () => provider('claude'), claude, native })

    hub.close()
    expect(claude.close).toHaveBeenCalledTimes(1)
    expect(native.close).toHaveBeenCalledTimes(1)
  })
})
