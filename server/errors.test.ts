import { describe, expect, it } from 'vitest'
import { HttpError, controlHttpError } from './errors.js'

describe('controlHttpError', () => {
  it('wraps a plain error into a 502 naming the action', () => {
    const e = controlHttpError('MCP toggle', new Error('boom'))
    expect(e).toBeInstanceOf(HttpError)
    expect(e.status).toBe(502)
    expect(e.message).toBe('MCP toggle failed: boom')
    expect(e.body).toBeUndefined()
  })

  it('attaches a structured body when the message matches a known pattern and classification is opted in', () => {
    const e = controlHttpError('MCP toggle', new Error('Connection closed'), { classify: true })
    expect(e.status).toBe(502)
    expect(e.message).toBe('MCP toggle failed: Connection closed')
    const body = e.body as { error: { code: string; message: string; hint: string } }
    expect(body.error.code).toBe('connection-closed')
    // The prose is preserved verbatim inside the structured body so logs and
    // older clients see the exact same text either way.
    expect(body.error.message).toBe('MCP toggle failed: Connection closed')
    expect(body.error.hint).toBeTruthy()
  })

  it('does not classify by default — MCP-flavored hints never attach to non-MCP control actions', () => {
    const e = controlHttpError('interrupt', new Error('Connection closed'))
    expect(e.message).toBe('interrupt failed: Connection closed')
    expect(e.body).toBeUndefined()
  })

  it('stringifies non-Error throwables', () => {
    const e = controlHttpError('model switching', 'kaboom')
    expect(e.message).toBe('model switching failed: kaboom')
  })

  it('passes an HttpError through untouched', () => {
    const original = new HttpError(409, 'busy')
    expect(controlHttpError('MCP reconnect', original)).toBe(original)
  })
})
