// The body readers are the single choke point every JSON-endpoint handler goes
// through, so their contract gets pinned here rather than re-discovered per
// endpoint: a JSON `null` used to be returned as null and thrown as a
// TypeError → opaque 500 from the first handler that read `body.field`.

import { describe, expect, it } from 'vitest'
import { safeJson, safeJsonValue, type JsonBodyReader } from './index.js'

/** The shape safeJson takes: a request whose `.json()` casts to T without
 *  checking anything — which is exactly the gap under test. */
type BodyReader = JsonBodyReader

/** Stand-in for Hono's request that parses a fixed value. */
const body = (value: unknown, contentType: string | null = 'application/json'): BodyReader => ({
  json<T>(): Promise<T> { return Promise.resolve(value as T) },
  header: (name: string) => (name.toLowerCase() === 'content-type' ? contentType ?? undefined : undefined),
})

/** Stand-in for a request whose body is not valid JSON at all. */
const malformed: BodyReader = {
  json<T>(): Promise<T> {
    return Promise.reject(new SyntaxError('Unexpected end of JSON input'))
  },
  header: () => 'application/json',
}

describe('safeJson — requires an object body', () => {
  it('returns an object, including the empty one', async () => {
    expect(await safeJson<{ a?: number }>(body({ a: 1 }))).toEqual({ a: 1 })
    expect(await safeJson<Record<string, unknown>>(body({}))).toEqual({})
  })

  it('400s on a JSON null body', async () => {
    await expect(safeJson(body(null))).rejects.toMatchObject({
      status: 400,
      message: 'Body must be a JSON object',
    })
  })

  it('400s on an array', async () => {
    await expect(safeJson(body([1, 2]))).rejects.toMatchObject({ status: 400 })
  })

  it('400s on a string and a number', async () => {
    await expect(safeJson(body('x'))).rejects.toMatchObject({ status: 400 })
    await expect(safeJson(body(7))).rejects.toMatchObject({ status: 400 })
  })

  it('400s on malformed JSON, distinct from a non-object body', async () => {
    await expect(safeJson(malformed)).rejects.toMatchObject({
      status: 400,
      message: 'Malformed JSON body',
    })
  })
})

describe('safeJsonValue — accepts any JSON body', () => {
  it('passes a JSON null through, since some bodies mean "clear it"', async () => {
    // POST /sessions/:id/sandbox takes exactly this — see its handler.
    expect(await safeJsonValue(body(null))).toBeNull()
  })

  it('passes arrays, primitives and objects through unchecked', async () => {
    expect(await safeJsonValue(body([1, 2]))).toEqual([1, 2])
    expect(await safeJsonValue(body('x'))).toBe('x')
    expect(await safeJsonValue(body(7))).toBe(7)
    expect(await safeJsonValue(body({ a: 1 }))).toEqual({ a: 1 })
  })

  it('still 400s on malformed JSON', async () => {
    await expect(safeJsonValue(malformed)).rejects.toMatchObject({
      status: 400,
      message: 'Malformed JSON body',
    })
  })
})

describe('JSON Content-Type requirement (CSRF choke point)', () => {
  it('415s on a missing Content-Type (not 400)', async () => {
    await expect(safeJson(body({ a: 1 }, null))).rejects.toMatchObject({ status: 415 })
    await expect(safeJsonValue(body({ a: 1 }, null))).rejects.toMatchObject({ status: 415 })
  })

  it('415s on text/plain even when the body is valid JSON', async () => {
    await expect(safeJson(body({ a: 1 }, 'text/plain;charset=UTF-8'))).rejects.toMatchObject({
      status: 415,
      message: 'Content-Type must be application/json',
    })
  })

  it('accepts application/json with a charset parameter', async () => {
    expect(await safeJson(body({ a: 1 }, 'application/json; charset=utf-8'))).toEqual({ a: 1 })
  })
})
