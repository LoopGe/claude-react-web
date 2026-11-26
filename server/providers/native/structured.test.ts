// server/providers/native/structured.test.ts
import { describe, it, expect } from 'vitest'
import { attachStructuredRuntime, STRUCTURED_OUTPUT_GUIDANCE, validateStructuredArgs } from './structured.js'

const schema = { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] }
const ctx = { cwd: '/tmp', signal: new AbortController().signal }

describe('attachStructuredRuntime', () => {
  it('names the tool StructuredOutput with the caller schema as parameters', () => {
    const a = attachStructuredRuntime(schema)
    expect(a.tool.name).toBe('StructuredOutput')
    expect(a.tool.schema).toEqual(schema)
  })
  it('captures a conforming value', async () => {
    const a = attachStructuredRuntime(schema)
    const out = await a.tool.run({ result: 'ok' }, ctx)
    expect(out.isError).toBeFalsy()
    expect(a.captured()).toEqual({ value: { result: 'ok' } })
  })
  it('rejects a non-conforming value with an error result and does not capture', async () => {
    const a = attachStructuredRuntime(schema)
    const out = await a.tool.run({ result: 123 }, ctx)
    expect(out.isError).toBe(true)
    expect(a.captured()).toBeUndefined()
  })
  it('rejects a missing required property', async () => {
    const a = attachStructuredRuntime(schema)
    const out = await a.tool.run({}, ctx)
    expect(out.isError).toBe(true)
    expect(a.captured()).toBeUndefined()
  })
  it('closes after capture: a second call cannot overwrite', async () => {
    const a = attachStructuredRuntime(schema)
    await a.tool.run({ result: 'first' }, ctx)
    const second = await a.tool.run({ result: 'second' }, ctx)
    expect(second.isError).toBe(true)
    expect(a.captured()).toEqual({ value: { result: 'first' } })
    expect(a.isClosed()).toBe(true)
  })
  it('carries the guidance instruction on the tool and stays open before capture', () => {
    const a = attachStructuredRuntime(schema)
    expect(a.tool.guidance).toBe(STRUCTURED_OUTPUT_GUIDANCE)
    expect(STRUCTURED_OUTPUT_GUIDANCE).toContain('StructuredOutput')
    expect(STRUCTURED_OUTPUT_GUIDANCE).toContain('plain text')
    expect(a.isClosed()).toBe(false)
    expect(a.captured()).toBeUndefined()
  })
  it('a rejected call leaves the run open for an in-turn retry', async () => {
    const a = attachStructuredRuntime(schema)
    const bad = await a.tool.run({ result: 123 }, ctx)
    expect(bad.isError).toBe(true)
    expect(a.isClosed()).toBe(false)
    const good = await a.tool.run({ result: 'retried' }, ctx)
    expect(good.isError).toBeFalsy()
    expect(a.captured()).toEqual({ value: { result: 'retried' } })
  })
})

describe('validateStructuredArgs (bounded, fail-closed)', () => {
  it('accepts a conforming nested object with array, enum and boolean fields', () => {
    const s = {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        score: { type: 'number' },
        approved: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        detail: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
      },
      required: ['verdict', 'score', 'approved', 'tags', 'detail'],
    }
    const value = {
      verdict: 'pass',
      score: 0.5,
      approved: true,
      tags: ['a', 'b'],
      detail: { note: 'ok' },
    }
    expect(validateStructuredArgs(s, value)).toEqual([])
  })
  it('rejects an enum violation', () => {
    const s = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } }, required: ['verdict'] }
    expect(validateStructuredArgs(s, { verdict: 'maybe' }).length).toBeGreaterThan(0)
  })
  it('rejects a non-conforming array item', () => {
    const s = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, required: ['tags'] }
    expect(validateStructuredArgs(s, { tags: ['a', 2] }).length).toBeGreaterThan(0)
  })
  it('rejects a nested required-property violation', () => {
    const s = {
      type: 'object',
      properties: { detail: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } },
      required: ['detail'],
    }
    expect(validateStructuredArgs(s, { detail: {} }).length).toBeGreaterThan(0)
  })
  it('checks the root type: null and arrays are not objects', () => {
    expect(validateStructuredArgs(schema, null).length).toBeGreaterThan(0)
    expect(validateStructuredArgs(schema, []).length).toBeGreaterThan(0)
    expect(validateStructuredArgs(schema, 'text').length).toBeGreaterThan(0)
  })
  it('fails closed on unsupported schema constructs instead of silently accepting', () => {
    // Each value would pass the supported subset; only the unsupported
    // construct can reject it, so a silently-ignoring validator fails here.
    const cases: Array<[Record<string, unknown>, unknown]> = [
      [{ type: 'object', properties: { x: { anyOf: [{ type: 'string' }] } } }, { x: 'anything' }],
      [{ type: 'object', properties: { x: { $ref: '#/definitions/x' } } }, { x: 'anything' }],
      [{ type: 'object', properties: { x: { type: 'integer' } } }, { x: 1 }],
      [{ type: 'object', properties: { x: { type: 'string', minLength: 1 } } }, { x: 'anything' }],
      [{ type: 'object', properties: { x: { type: ['string', 'null'] } } }, { x: 'anything' }],
      [{ type: 'object', properties: { x: { type: 'array', items: [{ type: 'string' }] } } }, { x: ['a'] }],
    ]
    for (const [s, value] of cases) {
      expect(validateStructuredArgs(s, value).length, JSON.stringify(s)).toBeGreaterThan(0)
    }
  })
  it('ignores pure annotation keywords (description / title)', () => {
    const s = {
      type: 'object',
      description: 'the result',
      title: 'Result',
      properties: { result: { type: 'string', description: 'a result' } },
      required: ['result'],
    }
    expect(validateStructuredArgs(s, { result: 'ok' })).toEqual([])
  })
  it('enum compares JSON values structurally, not by reference', () => {
    const s = { type: 'object', properties: { pick: { enum: [{ a: 1 }, [1, 2], null] } }, required: ['pick'] }
    expect(validateStructuredArgs(s, { pick: { a: 1 } })).toEqual([])
    expect(validateStructuredArgs(s, { pick: [1, 2] })).toEqual([])
    expect(validateStructuredArgs(s, { pick: null })).toEqual([])
    expect(validateStructuredArgs(s, { pick: { a: 2 } }).length).toBeGreaterThan(0)
  })
})
