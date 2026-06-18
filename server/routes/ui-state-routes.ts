// UI state routes: read/write session groups, sidebar order, collapsed groups.
// Persists to a single ui-state.json file on the server so the layout
// survives browser switches and device changes.

import { Hono } from 'hono'
import type { UiStateStore, UiState } from '../ui-state-store.js'
import { HttpError } from '../errors.js'
import { createErrorHandler } from '../errors.js'
import { safeJson } from './index.js'
import { createLogger } from '../log.js'

const log = createLogger('ui-state')

export function buildUiStateRouter(store: UiStateStore): Hono {
  const app = new Hono()
  app.onError(createErrorHandler('[ui-state]'))

  /** GET / — return the full ui-state snapshot. */
  app.get('/', (c) => {
    return c.json({ uiState: store.getState() })
  })

  /** PUT / — merge a partial update. The client sends the full merged
   *  { groups, sidebarOrder, collapsedGroups } object after every local
   *  mutation (debounced on the frontend). We replace the entire state
   *  rather than merging field-by-field because the client always has
   *  the canonical view. */
  app.put('/', async (c) => {
    const body = await safeJson<UiState>(c.req)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'body must be a UiState object')
    }
    // Validate shape defensively
    if (!Array.isArray(body.groups) || !Array.isArray(body.sidebarOrder)) {
      throw new HttpError(400, 'invalid ui-state shape')
    }
    store.update(body)
    return c.json({ uiState: store.getState() })
  })

  /** POST /import — one-time migration from legacy localStorage data.
   *  Only writes if ui-state.json does not already exist. */
  app.post('/import', async (c) => {
    const body = await safeJson<UiState>(c.req)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'body must be a UiState object')
    }
    const applied = await store.importFromLegacy(body)
    log.info(`import: applied=${applied}`)
    return c.json({ applied, uiState: store.getState() })
  })

  return app
}
