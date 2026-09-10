import { describe, it, expect, vi } from 'vitest'
import { buildDiagnosticsRouter } from './diagnostics.js'
import type { SessionManager } from '../session-manager.js'

const diagResponse = {
  cliDebug: { global: false, effective: false },
  stderrTail: ['boom'],
  debugLog: { exists: false },
}

function makeApp() {
  const sm = {
    getDiagnostics: vi.fn(async () => diagResponse),
    setCliDebug: vi.fn(async (_id: string, body: { cliDebug?: boolean | null }) => ({
      cliDebug: { global: false, perSession: body.cliDebug ?? undefined, effective: body.cliDebug ?? false },
      note: 'applies on the next session start',
    })),
  }
  return { app: buildDiagnosticsRouter(sm as unknown as SessionManager), sm }
}

describe('diagnostics routes', () => {
  it('GET returns diagnostics for the session', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/diagnostics')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(diagResponse)
    expect(sm.getDiagnostics).toHaveBeenCalledWith('s1')
  })

  it('PUT sets per-session cliDebug override', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/diagnostics', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cliDebug: true }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { cliDebug: { perSession?: boolean; effective: boolean }; note: string }
    expect(body.cliDebug.perSession).toBe(true)
    expect(body.cliDebug.effective).toBe(true)
    expect(body.note).toBe('applies on the next session start')
    expect(sm.setCliDebug).toHaveBeenCalledWith('s1', { cliDebug: true })
  })

  it('PUT with cliDebug: null clears the override', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/diagnostics', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cliDebug: null }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { cliDebug: { perSession?: boolean; effective: boolean } }
    expect(body.cliDebug.perSession).toBeUndefined()
    expect(body.cliDebug.effective).toBe(false)
    expect(sm.setCliDebug).toHaveBeenCalledWith('s1', { cliDebug: null })
  })
})