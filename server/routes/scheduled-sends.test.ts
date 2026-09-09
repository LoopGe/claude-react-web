import { describe, expect, it, vi } from 'vitest'
import { HttpError, createErrorHandler } from '../errors.js'
import { ScheduledSendManager } from '../scheduled-send-manager.js'
import { buildScheduledSendRouter } from './scheduled-sends.js'
import type { ScheduledSendBody } from '../../shared/scheduled-send.js'

function make() {
  const sm = {
    get: vi.fn(() => ({ id: 's1' })),
  }
  const send = vi.fn(async (_id: string, _b: ScheduledSendBody) => ({ uuid: 'u' }))
  let now = 1_000_000
  const manager = new ScheduledSendManager({ send, now: () => now, tickMs: 86_400_000 })
  const app = buildScheduledSendRouter(sm as never, manager)
  app.onError(createErrorHandler('[test]'))
  return { app, sm, manager, send, setNow: (n: number) => { now = n } }
}

describe('scheduled-send routes', () => {
  it('POST schedules a pending send', async () => {
    const { app, manager } = make()
    const res = await app.request('/sessions/s1/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fireAt: 2_000_000, text: 'later' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { schedule: { sessionId: string; status: string } }
    expect(body.schedule.sessionId).toBe('s1')
    expect(body.schedule.status).toBe('pending')
    expect(manager.list('s1')).toHaveLength(1)
  })

  it('POST rejects a non-numeric fireAt with 400', async () => {
    const { app } = make()
    const res = await app.request('/sessions/s1/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('fireAt is required (epoch ms)')
  })

  it('POST rejects an invalid body the same way messages does', async () => {
    const { app } = make()
    const res = await app.request('/sessions/s1/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fireAt: 2_000_000, content: [{ type: 'video' }] }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('unsupported content block type: video')
  })

  it('GET lists schedules; 404 when the session is unknown', async () => {
    const { app, sm, manager } = make()
    manager.create('s1', { text: 'x' }, 2_000_000)
    const res = await app.request('/sessions/s1/schedules')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { schedules: unknown[] }).schedules).toHaveLength(1)

    sm.get.mockImplementationOnce(() => { throw new HttpError(404, 'session nope not found') })
    const res404 = await app.request('/sessions/nope/schedules')
    expect(res404.status).toBe(404)
  })

  it('DELETE cancels a pending schedule', async () => {
    const { app, manager } = make()
    const rec = manager.create('s1', { text: 'x' }, 2_000_000)
    const res = await app.request(`/sessions/s1/schedules/${rec.id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(manager.list('s1')[0]?.status).toBe('cancelled')
  })

  it('DELETE is 404 for an unknown schedule', async () => {
    const { app } = make()
    const res = await app.request('/sessions/s1/schedules/zzz', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('DELETE is 404 for an unknown session', async () => {
    const { app, sm } = make()
    sm.get.mockImplementationOnce(() => { throw new HttpError(404, 'session nope not found') })
    const res = await app.request('/sessions/nope/schedules/zzz', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('tick fires a due schedule through the send delegate', async () => {
    const { manager, send, setNow } = make()
    manager.create('s1', { text: 'later' }, 2_000_000)
    setNow(2_000_001)
    await manager.tick()
    expect(send).toHaveBeenCalledWith('s1', { text: 'later' })
    expect(manager.list('s1')[0]?.status).toBe('sent')
  })
})
