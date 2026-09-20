// Shared server context construction.
//
// Extracted from runServer() so the web launcher (server/cli.ts) and the
// desktop host (desktop/main.ts) build the SAME SessionManager, stores and
// Hono app from one code path. Host-specific concerns (auth token, HTTP
// listen, WS attach, browser open) stay in the host; everything here is
// transport-agnostic.

import type { Hono } from 'hono'
import pkg from '../package.json' with { type: 'json' }
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createLogger } from './log.js'
import { SessionStore } from './persistence.js'
import { coerceHostCwd, setServerDefaultCwd } from './default-cwd.js'
import { McpConfigStore } from './mcp-config.js'
import { AgentDefinitionStore } from './agent-definition-store.js'
import { SessionManager } from './session-manager.js'
import { SnippetStore } from './snippet-store.js'
import { UiStateStore } from './ui-state-store.js'
import { UploadStore } from './upload-store.js'
import { MpStore } from './mp-store.js'
import { AppPluginStore } from './app-plugins/app-plugin-store.js'
import { AppPluginMarketplaceStore } from './app-plugins/marketplace-store.js'
import { AppPluginManager } from './app-plugins/app-plugin-manager.js'
import { seedBuiltinMarketplace } from './app-plugins/builtin-marketplace.js'
import { resolveClaudeBinary } from './claude-binary.js'
import { enableDevMode, isDevRuntime } from './dev-mode.js'
import { firstPartyRegistry } from './sdk-tools/registry.js'
import { cleanupCliLogs } from './cli-diagnostics.js'
import { join } from 'node:path'

const log = createLogger('cli')

export interface ServerContextOptions {
  /** State directory (config.json, session metadata, logs). */
  stateDir: string
  /** Default cwd advertised to new sessions. */
  cwd?: string
  /** Default model advertised to new sessions. */
  model?: string
  /** Explicit claude CLI path; falls back to env/`which claude`. */
  claudeBinary?: string
  /** Mount the App Plugins subsystem. Default true. */
  appPlugins?: boolean
  /** Load app plugins without activating subprocesses. */
  safeMode?: boolean
  /** Register dev-only introspection tools. undefined = auto-detect. */
  dev?: boolean
  /** Bind info surfaced by GET /api/access-info (web host only). */
  bind?: { host: string; port: number }
}

export interface ServerContext {
  stateDir: string
  sessionManager: SessionManager
  app: Hono
  /** The app-plugin manager, even when disabled (so shutdown is uniform).
   *  Pass `appPluginManager` to hosts only when app plugins are enabled. */
  appPluginManager: AppPluginManager
  appPluginEnabled: boolean
  stores: {
    session: SessionStore
    mcp: McpConfigStore
    mp: MpStore
    snippet: SnippetStore
    uiState: UiStateStore
    agentDefinition: AgentDefinitionStore
    upload: UploadStore
    appPlugin: AppPluginStore
    appPluginMarketplace: AppPluginMarketplaceStore
  }
  claudeBinary?: string
  /** Flush every store + tear down plugins and sessions. */
  shutdown(): Promise<void>
}

/** Build the full server context for one state directory. */
export async function createServerContext(opts: ServerContextOptions): Promise<ServerContext> {
  const stateDir = opts.stateDir
  const appPluginsEnabled = opts.appPlugins !== false
  const safeMode = opts.safeMode === true

  await loadConfig(stateDir)

  const store = new SessionStore({ stateDir })
  const loaded = await store.load()
  if (loaded.length) log.info(`loaded ${loaded.length} session(s) from ${stateDir}`)

  const mcpStore = new McpConfigStore({ stateDir })
  const mcpServers = await mcpStore.load()
  if (mcpServers.length) log.info(`loaded ${mcpServers.length} MCP server(s) from ${stateDir}`)

  const mpStore = new MpStore({ stateDir })
  const mpEntries = await mpStore.load()
  if (mpEntries.length) log.info(`loaded ${mpEntries.length} marketplace(s) from ${stateDir}`)

  const snippetStore = new SnippetStore({ stateDir })
  const snippets = await snippetStore.load()
  if (snippets.length) log.info(`loaded ${snippets.length} composer snippet(s) from ${stateDir}`)

  const uiStateStore = new UiStateStore({ stateDir })
  await uiStateStore.load()

  const agentDefinitionStore = new AgentDefinitionStore({ stateDir })
  await agentDefinitionStore.load()

  const uploadStore = new UploadStore({ stateDir })
  const uploadEntries = await uploadStore.load()
  if (uploadEntries.length) {
    log.info(`loaded ${uploadEntries.length} uploaded-file registry ${uploadEntries.length === 1 ? 'entry' : 'entries'} from ${stateDir}`)
  }

  // Prune stale per-session CLI diagnostics (>14d). Fire-and-forget.
  void cleanupCliLogs(join(stateDir, 'logs'))
    .then((removed) => { if (removed) log.info(`cleaned ${removed} stale CLI diagnostic file(s)`) })
    .catch(() => undefined)

  const claudeBinary = resolveClaudeBinary(opts.claudeBinary)
  if (claudeBinary) {
    log.info(`using claude binary: ${claudeBinary}`)
  } else {
    log.info(
      'no claude binary explicitly set — relying on SDK auto-detection ' +
        '(if sessions fail with "Claude Code native binary not found", pass --claude-binary)',
    )
  }

  const sessionManager = new SessionManager({
    store,
    mcpConfigStore: mcpStore,
    mpStore,
    agentStore: agentDefinitionStore,
    claudeBinary,
    autoResume: true,
    crashRecovery: true,
  })

  if (opts.dev ?? isDevRuntime(process.argv[1], process.env)) {
    enableDevMode({ registry: firstPartyRegistry, sm: sessionManager })
  }

  const backfilled = await uploadStore.backfillFromSessions(sessionManager.list())
  if (backfilled > 0) {
    log.info(`backfilled ${backfilled} upload ${backfilled === 1 ? 'entry' : 'entries'} from session cwds`)
  }

  const appPluginStore = new AppPluginStore({ stateDir })
  const appPluginMarketplaceStore = new AppPluginMarketplaceStore({ stateDir })
  await appPluginMarketplaceStore.load()
  if (appPluginsEnabled) {
    await seedBuiltinMarketplace(appPluginMarketplaceStore)
  }
  const appPluginManager = new AppPluginManager({
    store: appPluginStore,
    stateDir,
    hostVersion: pkg.version,
    hostNodeMajor: Number((process.versions.node ?? '0.0.0').split('.')[0]),
    sm: sessionManager,
    safeMode,
    disabled: !appPluginsEnabled,
    marketplaceStore: appPluginMarketplaceStore,
  })
  await appPluginManager.initialize()
  if (!appPluginsEnabled) log.info('app plugins disabled')

  // The single default workspace for this process, resolved once. Every
  // surface that advertises or applies a default — GET /api/config,
  // GET /api/config/full, GET /api/fs/home, and session creation — reads it
  // back through serverDefaultCwd(), so they cannot disagree. They used to,
  // because each computed its own `process.cwd()`.
  // The single default workspace for this process, resolved once. Every
  // surface that advertises or applies a default — GET /api/config,
  // GET /api/config/full, GET /api/fs/home, and session creation — reads it
  // back through serverDefaultCwd(), so they cannot disagree. They used to,
  // because each computed its own `process.cwd()`.
  setServerDefaultCwd(coerceHostCwd(opts.cwd))

  const { app } = buildApp({
    sessionManager,
    sessionStore: store,
    mcpConfigStore: mcpStore,
    snippetStore,
    uploadStore,
    uiStateStore,
    agentDefinitionStore,
    mpStore,
    appPluginManager: appPluginsEnabled ? appPluginManager : undefined,
    appPluginMarketplaceStore: appPluginsEnabled ? appPluginMarketplaceStore : undefined,
    defaults: { model: opts.model, claudeBinary },
    configDir: stateDir,
    bind: opts.bind,
  })

  const stores = {
    session: store,
    mcp: mcpStore,
    mp: mpStore,
    snippet: snippetStore,
    uiState: uiStateStore,
    agentDefinition: agentDefinitionStore,
    upload: uploadStore,
    appPlugin: appPluginStore,
    appPluginMarketplace: appPluginMarketplaceStore,
  }

  const shutdown = async () => {
    try {
      // allSettled, not all: one failing store must not mask the others or
      // strand sibling flushes as unhandled rejections during teardown.
      const results = await Promise.allSettled([
        store.flush(),
        mcpStore.flush(),
        mpStore.flush(),
        snippetStore.flush(),
        uiStateStore.flush(),
        agentDefinitionStore.flush(),
        uploadStore.flush(),
        appPluginStore.flush(),
        appPluginMarketplaceStore.flush(),
      ])
      for (const r of results) {
        if (r.status === 'rejected') log.error('store flush error:', r.reason)
      }
    } catch (err) {
      log.error('store flush error:', err)
    }
    try {
      await appPluginManager.shutdown()
    } catch (err) {
      log.error('app plugins shutdown error:', err)
    }
    await sessionManager.shutdown()
  }

  return {
    stateDir,
    sessionManager,
    app,
    appPluginManager,
    appPluginEnabled: appPluginsEnabled,
    stores,
    claudeBinary,
    shutdown,
  }
}
