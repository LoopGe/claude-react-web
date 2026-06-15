import { Hono } from 'hono'
import type { MessageSearchResponse } from '../../shared/search-results.js'
import { SessionManager } from '../session-manager.js'

export function buildSearchRouter(sm: SessionManager): Hono {
  const app = new Hono()

  app.get('/search/messages', async (c) => {
    const query = c.req.query('q') ?? ''
    const limitRaw = c.req.query('limit')
    const limit = limitRaw != null && /^\d+$/.test(limitRaw) ? Number(limitRaw) : undefined
    const hits = await sm.searchMessages(query, { limit })
    return c.json({ query: query.trim(), hits } satisfies MessageSearchResponse)
  })

  return app
}
