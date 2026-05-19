// Session recap route: AI-generated summary.

import { Hono } from 'hono'
import { SessionManager } from '../session-manager.js'
import { generateRecap, updateRecapCacheAfterAppend } from '../recap.js'

export function buildRecapRouter(sm: SessionManager): Hono {
  const app = new Hono()

  app.post('/sessions/:id/recap', async (c) => {
    const id = c.req.param('id')
    const info = sm.get(id) // throws 404 if not found
    const history = sm.getHistory(id)
    if (!history) {
      // Dormant session — history is gone but metadata persists.
      const msgCount = info.messageCount
      if (msgCount > 0) {
        return c.json({
          summary: `Session with ${msgCount} message${msgCount === 1 ? '' : 's'} (dormant — resume to generate full recap).`,
          stats: { messageCount: msgCount, userTurns: 0, assistantTurns: 0, totalCostUsd: 0, durationMs: 0, toolsUsed: [] },
          cached: false,
          generatedAt: Date.now(),
          fallback: true,
        })
      }
      return c.json({
        summary: 'No messages yet.',
        stats: { messageCount: 0, userTurns: 0, assistantTurns: 0, totalCostUsd: 0, durationMs: 0, toolsUsed: [] },
        cached: false,
        generatedAt: Date.now(),
        fallback: true,
      })
    }
    const result = await generateRecap(history, id)
    const recapMsg = {
      type: 'recap',
      uuid: `recap:${id}:${result.generatedAt}`,
      session_id: id,
      recap: result,
      state: 'ready',
    }
    sm.appendRecap(id, recapMsg)
    // After appending the recap message, the history has grown by one and
    // the last message UUID is now the recap's UUID. If we don't update the
    // cache, the next request sees a mismatch and re-calls the LLM even
    // though no real user message was added. Only bump when generateRecap
    // actually cached the result (not for fallbacks, which are intentionally
    // not cached so retries remain possible).
    if (result.cached || !result.fallback) {
      const updatedHistory = sm.getHistory(id)
      if (updatedHistory) {
        const lastMsg = updatedHistory[updatedHistory.length - 1] as Record<string, unknown> | undefined
        updateRecapCacheAfterAppend(id, updatedHistory.length, (lastMsg?.uuid as string) ?? '')
      }
    }
    return c.json(result)
  })

  return app
}
