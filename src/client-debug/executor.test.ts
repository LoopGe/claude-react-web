// Tests for the client-debug DOM executor (src/client-debug/executor.ts).
// Runs in happy-dom (default for src/**): querySelectorAll, getComputedStyle
// and XMLSerializer are real; the canvas rasterizer is not available (getContext
// returns null), which is exactly the error path the screenshot op must surface
// cleanly.

import { describe, expect, it } from 'vitest'
import {
  DOM_EVAL_RESULT_CAP,
  DOM_QUERY_HTML_CAP,
  DOM_SCREENSHOT_URL_CAP,
} from '../../shared/client-debug.js'
import {
  buildScreenshotResult,
  clampRasterSize,
  collectComputedStyles,
  collectDomQuery,
  executeClientDebugOp,
  MAX_RASTER_DIM,
  safeSerializeValue,
  serializeElementToForeignObject,
} from './executor'

describe('collectDomQuery', () => {
  it('summarizes matched nodes (tag/id/classes/text/html)', () => {
    document.body.innerHTML = '<div id="a" class="x y"><p>hello</p></div>'
    const res = collectDomQuery({ selector: '#a' })
    expect(res.total).toBe(1)
    expect(res.nodes[0]).toMatchObject({ tag: 'DIV', id: 'a', classes: ['x', 'y'] })
    expect(res.nodes[0].text).toContain('hello')
    expect(res.nodes[0].html).toContain('<p>hello</p>')
  })

  it('caps returned nodes but reports the full hit count in total', () => {
    document.body.innerHTML = '<i class="m"></i><i class="m"></i><i class="m"></i>'
    const res = collectDomQuery({ selector: '.m', maxNodes: 2 })
    expect(res.total).toBe(3)
    expect(res.nodes).toHaveLength(2)
  })

  it('omits html when includeHtml is false', () => {
    document.body.innerHTML = '<b>bold</b>'
    const res = collectDomQuery({ selector: 'b', includeHtml: false })
    expect(res.nodes[0].html).toBeUndefined()
    expect(res.nodes[0].text).toBe('bold')
  })

  it('rejects an invalid selector with a presentable error', () => {
    expect(() => collectDomQuery({ selector: '' })).toThrow(/selector/i)
    expect(() => collectDomQuery({ selector: '<<<' })).toThrow()
  })

  it('truncates oversized outerHTML to the shared cap', () => {
    document.body.innerHTML = `<div>${'x'.repeat(DOM_QUERY_HTML_CAP + 1000)}</div>`
    const res = collectDomQuery({ selector: 'div' })
    expect((res.nodes[0].html ?? '').length).toBeLessThanOrEqual(DOM_QUERY_HTML_CAP + 20)
    expect(res.nodes[0].html).toContain('…')
  })
})

describe('collectComputedStyles', () => {
  it('returns computed styles of the first match', () => {
    document.body.innerHTML = '<p style="color: red">t</p>'
    const res = collectComputedStyles({ selector: 'p' })
    expect(res.tag).toBe('P')
    expect(res.styles.color).toBe('red')
  })

  it('filters to the requested property subset', () => {
    document.body.innerHTML = '<p style="color: red">t</p>'
    const res = collectComputedStyles({ selector: 'p', properties: ['color'] })
    expect(Object.keys(res.styles)).toEqual(['color'])
  })

  it('accepts camelCase property names (converted to kebab-case for getPropertyValue)', () => {
    document.body.innerHTML = '<p style="background-color: red; z-index: 3">t</p>'
    const res = collectComputedStyles({ selector: 'p', properties: ['backgroundColor', 'zIndex'] })
    expect(res.styles.backgroundColor).toBe('red')
    expect(res.styles.zIndex).toBe('3')
  })

  it('throws a presentable error when nothing matches', () => {
    expect(() => collectComputedStyles({ selector: '.nope' })).toThrow(/no element/i)
  })
})

describe('dom_eval', () => {
  it('evaluates sync expressions and returns the value', async () => {
    const res = await executeClientDebugOp('dom_eval', { code: '1+1' })
    expect(res).toEqual({ value: 2 })
  })

  it('supports async bodies', async () => {
    const res = await executeClientDebugOp('dom_eval', {
      code: 'return await Promise.resolve("ok")',
    })
    expect(res).toEqual({ value: 'ok' })
  })

  it('rejects with the evaluation error', async () => {
    await expect(executeClientDebugOp('dom_eval', { code: 'throw new Error("nope")' })).rejects.toThrow('nope')
  })
})

describe('safeSerializeValue', () => {
  it('passes JSON values through', () => {
    expect(safeSerializeValue({ a: [1, 'x', null] })).toEqual({ a: [1, 'x', null] })
  })

  it('maps an undefined result to null (JSON.stringify would otherwise drop it on the wire)', () => {
    expect(safeSerializeValue(undefined)).toBeNull()
    expect(safeSerializeValue({ value: undefined })).toEqual({ value: null })
  })

  it('stringifies BigInt and drops/describes functions without throwing', () => {
    const out = safeSerializeValue({ n: 1n, f: () => 1 }) as { n: string; f: string }
    expect(out.n).toBe('1n')
    expect(typeof out.f).toBe('string')
  })

  it('survives circular references', () => {
    const o: Record<string, unknown> = { name: 'root' }
    o.self = o
    const out = safeSerializeValue(o) as { name: string; self: string }
    expect(out.name).toBe('root')
    expect(typeof out.self).toBe('string')
  })

  it('keeps non-circular aliases of the same Set distinct from [Circular]', () => {
    const shared = new Set([1, 2])
    const out = safeSerializeValue({ a: shared, b: shared }) as {
      a: number[]
      b: number[]
    }
    expect(out.a).toEqual([1, 2])
    expect(out.b).toEqual([1, 2])
  })

  it('truncates oversized serialized output to the shared cap', () => {
    const out = safeSerializeValue({ big: 'y'.repeat(DOM_EVAL_RESULT_CAP * 2) }) as string
    expect(out.length).toBeLessThanOrEqual(DOM_EVAL_RESULT_CAP + 20)
    expect(out).toContain('…')
  })
})

describe('screenshot plumbing', () => {
  it('serializes an element into an SVG foreignObject with its box size', () => {
    document.body.innerHTML = '<div id="shot" style="width: 120px; height: 60px">hi</div>'
    const el = document.getElementById('shot')!
    const { svg, width, height } = serializeElementToForeignObject(el)
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
    expect(svg).toContain('foreignObject')
    expect(svg).toContain('hi')
  })

  it('dom_screenshot surfaces a clean error when the canvas rasterizer is unavailable', async () => {
    document.body.innerHTML = '<div id="shot2">hi</div>'
    await expect(executeClientDebugOp('dom_screenshot', { selector: '#shot2' })).rejects.toThrow(/canvas|2d/i)
  })

  it('clamps oversized capture boxes proportionally to the canvas dimension limit', () => {
    // A 1280×40000 transcript page would exceed canvas limits unscaled.
    const clamped = clampRasterSize(1280, 40_000)
    expect(clamped.height).toBe(MAX_RASTER_DIM)
    expect(clamped.width).toBe(Math.floor(1280 * (MAX_RASTER_DIM / 40_000)))
    // Smaller boxes are left untouched (never upscaled).
    expect(clampRasterSize(100, 50)).toEqual({ width: 100, height: 50 })
  })

  it('builds the screenshot result or rejects when the PNG exceeds the shared wire cap', () => {
    const tiny = buildScreenshotResult('data:image/png;base64,AAAA', 10, 10)
    expect(tiny).toEqual({ dataUrl: 'data:image/png;base64,AAAA', width: 10, height: 10 })
    const huge = 'data:image/png;base64,' + 'A'.repeat(DOM_SCREENSHOT_URL_CAP)
    expect(() => buildScreenshotResult(huge, 10, 10)).toThrow(/exceeds/i)
  })
})

describe('executeClientDebugOp dispatch', () => {
  it('rejects an unknown op', async () => {
    await expect(executeClientDebugOp('nope' as never, {})).rejects.toThrow(/unknown op/i)
  })

  it('rejects missing params', async () => {
    await expect(executeClientDebugOp('dom_query', {} as never)).rejects.toThrow(/selector/i)
  })
})
