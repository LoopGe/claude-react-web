// POST /config/reset — bulk-clear orchestrator for the "Clear configuration & data" dialog.

import { Hono } from 'hono'
import { HttpError, createErrorHandler } from '../errors.js'
import { safeJson } from './index.js'
import {
  SERVER_RESET_ITEMS,
  type ServerResetItem,
  type ResetResponse,
} from '../../shared/reset.js'
import {
  updateConfigFile,
  loadConfig,
  queueConfigWrite,
  DEFAULT_PROFILE,
  config as serverConfig,
  clearCredentials,
} from '../config.js'
import { clearLogFile, createLogger } from '../log.js'
import type { SessionManager } from '../session-manager.js'
import type { McpConfigStore } from '../mcp-config.js'
import type { MpStore } from '../mp-store.js'
import type { SnippetStore } from '../snippet-store.js'
import type { UiStateStore } from '../ui-state-store.js'

const log = createLogger('reset')

// app-settings clears these WRITABLE_CONFIG_KEYS (excludes connection + log
// keys). The model fields (modelList / recapModel / commitMessageModel) are
// NOT here — they are per-profile now, and a separate queueConfigWrite below
// resets each profile's model fields to DEFAULT_PROFILE (keeping credentials).
const APP_SETTING_KEYS: readonly string[] = [
  'maxUploadBytes', 'historyCap',
  'maxGroupPanels', 'maxOpenPanels', 'workingStuckMs', 'updateCheckRegistry', 'skillLoadMode',
  'enabledSkills', 'autoClassifierModel', 'autoClassifierTimeout',
  'showPinnedUserMessage', 'autoRecap', 'appToolsGit', 'firstPartyTools', 'allowSensitivePathEdits',
]

export interface ResetRouterDeps {
  sm: SessionManager
  configDir: string
  mcpStore: McpConfigStore
  mpStore: MpStore
  snippetStore: SnippetStore
  uiStateStore: UiStateStore
}

export function buildResetRouter(deps: ResetRouterDeps): Hono {
  const app = new Hono()

  app.onError(createErrorHandler('[reset]'))

  app.post('/config/reset', async (c) => {
    const { items } = await safeJson<{ items: ServerResetItem[] }>(c.req)
    if (!Array.isArray(items)) throw new HttpError(400, 'items must be an array')
    const invalid = items.filter((it) => !SERVER_RESET_ITEMS.includes(it))
    if (invalid.length) throw new HttpError(400, `unknown reset items: ${invalid.join(', ')}`)

    const results: ResetResponse['results'] = {}
    const deletedSessionIds: string[] = []

    const run = async (item: ServerResetItem, fn: () => Promise<unknown>) => {
      try {
        await fn()
        results[item] = { ok: true }
      } catch (e) {
        results[item] = { ok: false, error: (e as Error).message }
        log.warn(`[${item}] clear failed: ${(e as Error).message}`)
      }
    }

    for (const item of items) {
      switch (item) {
        case 'app-settings':
          await run(item, async () => {
            const nulls: Record<string, null> = {}
            for (const k of APP_SETTING_KEYS) nulls[k] = null
            await updateConfigFile(deps.configDir, nulls)
            await queueConfigWrite(deps.configDir, (existing) => {
              const profiles = Array.isArray(existing.profiles) ? existing.profiles : []
              existing.profiles = profiles.map((p) => {
                if (typeof p !== 'object' || p === null) return p
                return {
                  ...p,
                  modelList: [...DEFAULT_PROFILE.modelList],
                  modelGroups: [...DEFAULT_PROFILE.modelGroups],
                  recapModel: DEFAULT_PROFILE.recapModel,
                  commitMessageModel: DEFAULT_PROFILE.commitMessageModel,
                }
              })
            })
            await loadConfig(deps.configDir)
          })
          break
        case 'mcp-configs': await run(item, () => deps.mcpStore.clearAll()); break
        case 'marketplaces': await run(item, () => deps.mpStore.clearAll()); break
        case 'snippets': await run(item, () => deps.snippetStore.clearAll()); break
        case 'ui-state': await run(item, () => deps.uiStateStore.clearAll()); break
        case 'logs': await run(item, () => clearLogFile(deps.configDir, !!serverConfig.logToFile)); break
        case 'credentials': await run(item, () => clearCredentials(deps.configDir)); break
        case 'sessions':
          await run(item, async () => {
            const sessions = deps.sm.list()
            let failed = 0
            for (const s of sessions) {
              // Best-effort per session: a stuck/unloadable session must not
              // abort the rest. Only record ids we actually removed.
              try {
                await deps.sm.delete(s.id)
                deletedSessionIds.push(s.id)
              } catch (e) {
                failed++
                log.warn(`[sessions] failed to delete ${s.id}: ${(e as Error).message}`)
              }
            }
            if (failed > 0) throw new Error(`${failed} session(s) could not be deleted`)
            // Await the debounced flush so deletions are on disk before we
            // respond — without this, a crash within the debounce window
            // silently loses the reset (sessions reappear on restart).
            await deps.sm.flushStore()
          })
          break
      }
    }

    return c.json({ results, deletedSessionIds } satisfies ResetResponse)
  })

  return app
}
