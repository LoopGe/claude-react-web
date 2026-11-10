import type { MpStore } from '../mp-store.js'
import type { AgentDefinitionStore } from '../agent-definition-store.js'
import { createMcpOAuthProvider, type McpConfigStore } from '../mcp-config.js'
import type { ProcessExitInfo } from '../process-monitor.js'
import { ClaudeProvider } from './claude/claude-provider.js'
import { NativeProvider } from './native/native-provider.js'
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
  /** App state directory. The native provider keeps its session logs under
   *  `<stateDir>/native-sessions/`; omitted falls back to the default
   *  state-dir resolution. */
  stateDir?: string
}

export function createDefaultProviders(opts: DefaultProvidersOptions = {}): ProviderRegistry {
  const registry = new ProviderRegistry()
  registry.register(new ClaudeProvider(opts))
  // Remote MCP servers with stored OAuth state need a provider that reads and
  // refreshes those tokens. The native path connects in-process, so it gets
  // the same resolver the CLI path uses; a saved token flushes the store.
  const mcpStore = opts.mcpStore
  const authFor = mcpStore
    ? (name: string) => {
        const stored = mcpStore.get(name)
        return stored
          ? createMcpOAuthProvider(stored, () => {
              // The provider mutates the stored server's OAuth state in place;
              // upsert re-marks the store dirty (flush is a no-op otherwise).
              mcpStore.upsert(stored)
              void mcpStore.flush()
            })
          : undefined
      }
    : undefined
  registry.register(new NativeProvider({ stateDir: opts.stateDir, authFor }))
  return registry
}
