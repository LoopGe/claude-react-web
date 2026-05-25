// Session recap route: AI-generated summary.
//
// Successful recaps and failures are both persisted as a synthetic
// `type: 'recap'` message in the session history (state:'ready' or
// state:'error'). The message is broadcast over WS so all live tabs
// see it. The HTTP body mirrors what was persisted so callers that
// don't subscribe still know what happened.

import { Hono } from 'hono'
import { SessionManager } from '../session-manager.js'
import { generateRecap, updateRecapCacheAfterAppend } from '../recap.js'

interface ErrorRecapBody {
  state: 'error'
  error: string
  generatedAt: number
}

export function buildRecapRouter(sm: SessionManager): Hono {
  const app = new Hono()

  app.post('/sessions/:id/recap', async (c) => {
    const id = c.req.param('id')
    sm.get(id) // throws 404 if not found
    const history = sm.getHistory(id)

    // Dormant session — history was GC'd from memory. Can't summarise
    // and can't broadcast (no live subscribers, appendRecap would no-op).
    // Surface the reason in the response body. The client's loading
    // splice clears on response; the user sees no transcript update,
    // which matches the pre-change behaviour for dormant sessions.
    if (!history) {
      const body: ErrorRecapBody = {
        state: 'error',
        error: 'Session is dormant — resume it to generate a recap.',
        generatedAt: Date.now(),
      }
      return c.json(body)
    }

    try {
      const result = await generateRecap(history, id)
      const recapMsg = {
        type: 'recap',
        uuid: `recap:${id}:${result.generatedAt}`,
        session_id: id,
        recap: result,
        state: 'ready',
      }
      sm.appendRecap(id, recapMsg)
      // After appending, the history has grown by one and the last
      // message UUID is now the recap's UUID. Bump the cache fingerprint
      // so the next request hits the cache instead of re-calling the LLM.
      const updatedHistory = sm.getHistory(id)
      if (updatedHistory) {
        const lastMsg = updatedHistory[updatedHistory.length - 1] as Record<string, unknown> | undefined
        updateRecapCacheAfterAppend(id, updatedHistory.length, (lastMsg?.uuid as string) ?? '')
      }
      return c.json(result)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.warn(`[recap] generation failed for ${id}:`, errMsg)
      const generatedAt = Date.now()
      // Persist the error as a state:'error' recap message so all live
      // subscribers see "⚠️ Recap unavailable" instead of a stuck loading
      // bar. appendRecap replaces any prior recap message — a successful
      // retry will overwrite this card.
      const recapMsg = {
        type: 'recap',
        uuid: `recap:${id}:${generatedAt}`,
        session_id: id,
        state: 'error',
        error: errMsg,
      }
      sm.appendRecap(id, recapMsg)
      const body: ErrorRecapBody = { state: 'error', error: errMsg, generatedAt }
      return c.json(body)
    }
  })

  return app
}
