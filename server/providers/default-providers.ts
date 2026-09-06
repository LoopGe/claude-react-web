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
}

export function createDefaultProviders(opts: DefaultProvidersOptions = {}): ProviderRegistry {
  const registry = new ProviderRegistry()
  registry.register(new ClaudeProvider(opts))
  return registry
}
