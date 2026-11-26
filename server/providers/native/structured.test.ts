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
  it('declares the capture tool read-only (permission-gate evidence)', () => {
    // The capture records the answer without touching the filesystem; the
    // hint is the plan gate's read-only evidence and the headless one-shot
    // gate's auto-allow channel.
    const a = attachStructuredRuntime(schema)
    expect(a.tool.readOnlyHint).toBe(true)
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

describe('bounded schema support: attach-time scan + value validation', () => {
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
  it('throws at attach time on unsupported schema constructs (caller error, not model-retryable)', () => {
    // An unsupported schema can never be satisfied by corrected arguments, so
    // it must surface loudly to the caller/wiring, never as a retry instruction.
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ type: 'object', properties: { x: { anyOf: [{ type: 'string' }] } } }, /anyOf/],
      [{ type: 'object', properties: { x: { $ref: '#/definitions/x' } } }, /\$ref/],
      [{ type: 'object', properties: { x: { type: 'string', minLength: 1 } } }, /minLength/],
      [{ type: 'object', properties: { x: { type: ['string', 'null'] } } }, /unsupported type/],
      [{ type: 'object', additionalProperties: { type: 'string' } }, /additionalProperties/],
    ]
    for (const [s, message] of cases) {
      expect(() => attachStructuredRuntime(s), JSON.stringify(s)).toThrow(message)
    }
  })
  it('shape-checks items at attach regardless of value: unsupported items with an empty array still throws', () => {
    for (const items of [[{ type: 'string' }], true, 42]) {
      const s = { type: 'object', properties: { x: { type: 'array', items } } }
      expect(() => attachStructuredRuntime(s), JSON.stringify(items)).toThrow()
    }
  })
  it('accepts a valid integer field and rejects a non-integer retryably', async () => {
    const s = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }
    const a = attachStructuredRuntime(s)
    const good = await a.tool.run({ count: 3 }, ctx)
    expect(good.isError).toBeFalsy()
    expect(a.captured()).toEqual({ value: { count: 3 } })
    const b = attachStructuredRuntime(s)
    const bad = await b.tool.run({ count: 1.5 }, ctx)
    expect(bad.isError).toBe(true)
    expect(b.captured()).toBeUndefined()
    expect(b.isClosed()).toBe(false)
    expect(validateStructuredArgs(s, { count: 1.5 }).length).toBeGreaterThan(0)
  })
  it('accepts the null type for null values only', () => {
    const s = { type: 'object', properties: { x: { type: 'null' } }, required: ['x'] }
    expect(validateStructuredArgs(s, { x: null })).toEqual([])
    expect(validateStructuredArgs(s, { x: 0 }).length).toBeGreaterThan(0)
    expect(validateStructuredArgs(s, { x: 'null' }).length).toBeGreaterThan(0)
  })
  it('additionalProperties:false rejects unknown keys retryably and accepts known-only', async () => {
    const s = {
      type: 'object',
      properties: { result: { type: 'string' } },
      required: ['result'],
      additionalProperties: false,
    }
    const a = attachStructuredRuntime(s)
    const bad = await a.tool.run({ result: 'ok', extra: 1 }, ctx)
    expect(bad.isError).toBe(true)
    expect(a.captured()).toBeUndefined()
    expect(a.isClosed()).toBe(false)
    const good = await a.tool.run({ result: 'ok' }, ctx)
    expect(good.isError).toBeFalsy()
    expect(a.captured()).toEqual({ value: { result: 'ok' } })
  })
  it('additionalProperties:false with no properties rejects every key; true is inert', () => {
    const closed = { type: 'object', additionalProperties: false }
    expect(validateStructuredArgs(closed, {})).toEqual([])
    expect(validateStructuredArgs(closed, { anything: 1 }).length).toBeGreaterThan(0)
    const open = { type: 'object', properties: { result: { type: 'string' } }, additionalProperties: true }
    expect(validateStructuredArgs(open, { result: 'ok', extra: 1 })).toEqual([])
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
