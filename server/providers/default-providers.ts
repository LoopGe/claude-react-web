import type { MpStore } from '../mp-store.js'
import type { AgentDefinitionStore } from '../agent-definition-store.js'
import type { McpConfigStore } from '../mcp-config.js'
import type { ProcessExitInfo } from '../process-monitor.js'
import { ClaudeProvider } from './claude/claude-provider.js'
import { ProviderRegistry } from './registry.js'

export interface DefaultProvidersOptions {
  claudeBinary?: string
  mpStore?: MpStore
  agentStore?: AgentDefinitionStore
  mcpStore?: McpConfigStore
  onProcessExit?: (info: ProcessExitInfo) => void
  /** Directory for session-scoped CLI diagnostic logs. Passed through to
   *  ClaudeProvider for stderr tee + SDK debug log files. */
  logsDir?: string
}

export function createDefaultProviders(opts: DefaultProvidersOptions = {}): ProviderRegistry {
  const registry = new ProviderRegistry()
  registry.register(new ClaudeProvider(opts))
  return registry
}
