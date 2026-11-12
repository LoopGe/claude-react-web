import { HttpError } from './errors.js'
import type { AgentProvider } from './providers/types.js'
import type { SubagentTranscriptSub } from './subagent-transcript-hub.js'

/** Provider-owned standalone subagent transcript stream. The reset/append
 * frame and subscription lifecycle are shared with the existing WS wire. */
export interface SubagentTranscriptSource {
  subscribeSubagentTranscript(sessionId: string, agentId: string): SubagentTranscriptSub
  close?(): void
}

interface ProviderSubagentTranscriptHubOptions {
  resolveProvider: (sessionId: string) => AgentProvider
  claude: SubagentTranscriptSource
  native: SubagentTranscriptSource
}

/** Select a transcript source through the manager's provider/capability
 * resolver. Resolution happens per subscription so dormant metadata and live
 * sessions follow the same rules as REST transcript reads. */
export class ProviderSubagentTranscriptHub implements SubagentTranscriptSource {
  constructor(private readonly opts: ProviderSubagentTranscriptHubOptions) {}

  subscribeSubagentTranscript(sessionId: string, agentId: string): SubagentTranscriptSub {
    const provider = this.opts.resolveProvider(sessionId)
    const source = provider.name === 'claude'
      ? this.opts.claude
      : provider.name === 'native'
        ? this.opts.native
        : null
    if (!source) {
      throw new HttpError(501, `provider ${provider.name} does not support subagent transcript streaming`)
    }
    return source.subscribeSubagentTranscript(sessionId, agentId)
  }

  close(): void {
    this.opts.claude.close?.()
    this.opts.native.close?.()
  }
}
