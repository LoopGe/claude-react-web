// Browser-side executor for the dev-only `appdebug` client-debug channel.
//
// Receives one op (from a `client-debug-request` WS frame) and runs it
// against the REAL document of this tab, returning a JSON-safe result. The
// caller (useClientDebug) wraps everything into the POST answer — including
// failures, which must always be answered (the host broker is parked until
// the first answer or its timeout).
//
// Browser-API split, so the DOM work is testable in a DOM environment:
//   - collectDomQuery / collectComputedStyles / serializeElementToForeignObject
//     / safeSerializeValue — pure DOM+serialization, run under happy-dom.
//   - rasterizeSvgToDataUrl — needs a real 2D canvas (unavailable in test
//     DOMs); executeClientDebugOp surfaces that as a presentable error.
//
// All size caps come from shared/client-debug.ts. Screenshot fidelity note:
// foreignObject rendering drops external images/CORS fonts by design — this
// is a debug tool, not a pixel-perfect renderer.

import {
  DOM_EVAL_RESULT_CAP,
  DOM_QUERY_HTML_CAP,
  DOM_QUERY_TEXT_CAP,
  DOM_SCREENSHOT_URL_CAP,
  type ClientDebugNode,
  type ClientDebugOp,
  type DomComputedStylesResult,
  type DomEvalResult,
  type DomQueryResult,
  type DomScreenshotResult,
} from '../../shared/client-debug.js'

// --- shared helpers ---------------------------------------------------------

function requireString(params: Record<string, unknown>, key: string): string {
  const v = params[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${key} (non-empty string) is required`)
  }
  return v
}

function truncate(s: string, cap: number): string {
  return s.length <= cap ? s : s.slice(0, cap) + '…'
}

/** Curated computed-style subset when the caller passes no property list —
 *  the full getComputedStyle dump is ~300 properties of mostly noise. */
const DEFAULT_STYLE_PROPERTIES = [
  'display', 'position', 'visibility', 'zIndex', 'opacity',
  'boxSizing', 'width', 'height', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderTopColor', 'borderRadius',
  'color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'textAlign',
  'flexDirection', 'justifyContent', 'alignItems', 'gap',
  'gridTemplateColumns', 'overflow', 'whiteSpace',
]

// --- dom_query --------------------------------------------------------------

export function collectDomQuery(params: Record<string, unknown>): DomQueryResult {
  const selector = requireString(params, 'selector')
  const maxNodesRaw = params.maxNodes
  const maxNodes =
    typeof maxNodesRaw === 'number' && Number.isInteger(maxNodesRaw) && maxNodesRaw > 0
      ? Math.min(maxNodesRaw, 50)
      : 10
  const includeHtml = params.includeHtml !== false

  let matches: NodeListOf<Element>
  try {
    matches = document.querySelectorAll(selector)
  } catch (e) {
    throw new Error(`invalid selector ${JSON.stringify(selector)}: ${(e as Error).message}`)
  }

  const nodes: ClientDebugNode[] = []
  const stop = Math.min(matches.length, maxNodes)
  for (let i = 0; i < stop; i++) {
    const el = matches[i]!
    const node: ClientDebugNode = {
      tag: el.tagName,
      text: truncate((el.textContent ?? '').trim().replace(/\s+/g, ' '), DOM_QUERY_TEXT_CAP),
    }
    const id = el.getAttribute('id')
    if (id) node.id = id
    const classes = Array.from(el.classList)
    if (classes.length > 0) node.classes = classes
    if (includeHtml) node.html = truncate(el.outerHTML, DOM_QUERY_HTML_CAP)
    nodes.push(node)
  }
  return { total: matches.length, nodes }
}

// --- dom_computed_styles ------------------------------------------------------

export function collectComputedStyles(params: Record<string, unknown>): DomComputedStylesResult {
  const selector = requireString(params, 'selector')
  let el: Element | null = null
  try {
    el = document.querySelector(selector)
  } catch (e) {
    throw new Error(`invalid selector ${JSON.stringify(selector)}: ${(e as Error).message}`)
  }
  if (!el) throw new Error(`no element matches ${JSON.stringify(selector)}`)

  const requested = Array.isArray(params.properties) ? params.properties.filter((p): p is string => typeof p === 'string') : null
  const wanted = requested && requested.length > 0 ? requested : DEFAULT_STYLE_PROPERTIES
  const cs = getComputedStyle(el)
  const styles: Record<string, string> = {}
  for (const prop of wanted) {
    // getPropertyValue matches the hyphenated CSS name; camelCase only works
    // as a JS property accessor, so convert ('backgroundColor' → 'background-color').
    const cssName = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
    styles[prop] = cs.getPropertyValue(cssName)
  }
  const res: DomComputedStylesResult = { tag: el.tagName, styles }
  const id = el.getAttribute('id')
  if (id) res.id = id
  const classes = Array.from(el.classList)
  if (classes.length > 0) res.classes = classes
  return res
}

// --- dom_screenshot -----------------------------------------------------------

/** Inline each element's computed styles into a style attribute so the cloned
 *  subtree renders without the page's stylesheets (foreignObject serialization
 *  does not carry CSS rules over). External images are dropped by leaving src
 *  untouched — data: URLs survive, cross-origin ones would taint nothing since
 *  we serialize to SVG text (not canvas reads of the live page). */
function inlineStyles(source: Element, clone: Element): void {
  const cs = getComputedStyle(source)
  let css = ''
  for (let i = 0; i < cs.length; i++) {
    const prop = cs[i]
    css += `${prop}:${cs.getPropertyValue(prop)};`
  }
  clone.setAttribute('style', css)
  const sourceChildren = source.children
  const cloneChildren = clone.children
  for (let i = 0; i < sourceChildren.length; i++) {
    inlineStyles(sourceChildren[i], cloneChildren[i])
  }
}

/** Serialize one element (with inlined computed styles) into a standalone SVG
 *  wrapping a foreignObject. Pure DOM work — testable without a canvas. */
export function serializeElementToForeignObject(el: Element): { svg: string; width: number; height: number } {
  const rect = el.getBoundingClientRect()
  const width = Math.max(1, Math.ceil(rect.width))
  const height = Math.max(1, Math.ceil(rect.height))
  const clone = el.cloneNode(true) as Element
  inlineStyles(el, clone)
  clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')

  const serializer = new XMLSerializer()
  const inner = serializer.serializeToString(clone)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject width="100%" height="100%">${inner}</foreignObject></svg>`
  return { svg, width, height }
}

/** Canvas dimension ceiling. Chrome allows up to ~32,767 px per side and a
 *  large area budget; a full-page capture of a long transcript (tens of
 *  thousands of px tall) would exceed both, so oversized captures are scaled
 *  down proportionally to fit. */
export const MAX_RASTER_DIM = 8192

/** Proportionally scale an (width, height) capture box so its longest side is
 *  ≤ MAX_RASTER_DIM. Never upscales. */
export function clampRasterSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_RASTER_DIM / width, MAX_RASTER_DIM / height)
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }
}

/** Assemble the screenshot result, enforcing the shared wire cap. A data URL
 *  cannot be truncated (that would corrupt the base64 payload), so an
 *  oversized capture is a hard error — the caller retries with a narrower
 *  selector rather than shipping unusable bytes. */
export function buildScreenshotResult(dataUrl: string, width: number, height: number): DomScreenshotResult {
  if (dataUrl.length > DOM_SCREENSHOT_URL_CAP) {
    throw new Error(
      `screenshot PNG (${Math.round(dataUrl.length / 1024)}KB) exceeds the ` +
        `${Math.round(DOM_SCREENSHOT_URL_CAP / 1024)}KB wire cap — capture a narrower selector instead`,
    )
  }
  return { dataUrl, width, height }
}

/** Some browsers (documented WebKit cases) fire neither onload nor onerror
 *  for large/malformed SVG data URLs — without this bound the promise never
 *  settles and the host parks the tool call for its whole timeout. */
const IMG_DECODE_TIMEOUT_MS = 10_000

/** Rasterize an SVG string to a PNG of at most MAX_RASTER_DIM per side.
 *  Returns the CLAMPED dimensions — they are the actual PNG's size, not the
 *  requested capture box. Requires a real 2D canvas — test DOMs
 *  (happy-dom/jsdom) have none, so the error path is the contract. */
export function rasterizeSvgToDataUrl(
  svg: string,
  width: number,
  height: number,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const canvas = document.createElement('canvas')
  const raster = clampRasterSize(width, height)
  canvas.width = raster.width
  canvas.height = raster.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.reject(new Error('canvas 2D context unavailable in this environment'))
  const img = new Image()
  const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  // Synchronous decode is not exposed; draw via onload. The whole screenshot
  // op is async, so waiting here is fine.
  return new Promise<{ dataUrl: string; width: number; height: number }>((resolve, reject) => {
    let settleTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      settleTimer = null
      reject(new Error('screenshot rasterization timed out waiting for the SVG to decode'))
    }, IMG_DECODE_TIMEOUT_MS)
    const settle = (fn: () => void) => {
      if (settleTimer == null) return
      clearTimeout(settleTimer)
      settleTimer = null
      fn()
    }
    img.onload = () =>
      settle(() => {
        try {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
          resolve({ dataUrl: canvas.toDataURL('image/png'), width: raster.width, height: raster.height })
        } catch (e) {
          reject(new Error(`screenshot rasterization failed: ${(e as Error).message}`))
        }
      })
    img.onerror = () => settle(() => reject(new Error('screenshot rasterization failed: invalid SVG')))
    img.src = svgUrl
  })
}

async function collectScreenshot(params: Record<string, unknown>): Promise<DomScreenshotResult> {
  const selector = params.selector
  let el: Element
  if (typeof selector === 'string' && selector.length > 0) {
    const found = document.querySelector(selector)
    if (!found) throw new Error(`no element matches ${JSON.stringify(selector)}`)
    el = found
  } else {
    el = document.documentElement
  }
  const { svg, width, height } = serializeElementToForeignObject(el)
  const raster = await rasterizeSvgToDataUrl(svg, width, height)
  return buildScreenshotResult(raster.dataUrl, raster.width, raster.height)
}

// --- dom_eval -----------------------------------------------------------------

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (body: string) => (...args: unknown[]) => Promise<unknown>

/** JSON-safe serialization: BigInt → string, functions → description,
 *  cycles → '[Circular]', everything else passes through. Oversized results
 *  are JSON-stringified once and truncated to the shared cap. */
export function safeSerializeValue(value: unknown): unknown {
  // Maps each visited object to its serialized replacement. Written ONCE per
  // object (pre-allocated before walking children): a second reference to
  // the same object returns the replacement (aliasing preserved), a true
  // cycle reads the placeholder written by its own ancestor.
  const seen = new WeakMap<object, unknown>()
  const walk = (v: unknown, depth: number): unknown => {
    // Map undefined → null everywhere (top level, object values, array
    // slots): JSON.stringify drops undefined keys on the wire, so an eval
    // that legitimately returned undefined must surface as null instead.
    if (v === undefined) return null
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'bigint') return v.toString() + 'n'
      if (typeof v === 'function') return `[Function ${(v as { name?: string }).name || 'anonymous'}]`
      if (typeof v === 'symbol') return v.toString()
      return v
    }
    const existing = seen.get(v as object)
    if (existing !== undefined) return existing
    if (depth > 8) return '[Deep]'
    const placeholder = '[Circular]'
    seen.set(v as object, placeholder)
    let out: unknown
    if (v instanceof Map) {
      const o: Record<string, unknown> = {}
      for (const [k, val] of v) o[String(k)] = walk(val, depth + 1)
      out = o
    } else if (v instanceof Set) {
      out = Array.from(v).map((x) => walk(x, depth + 1))
    } else if (Array.isArray(v)) {
      out = v.map((x) => walk(x, depth + 1))
    } else {
      const o: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        o[k] = walk(val, depth + 1)
      }
      out = o
    }
    seen.set(v as object, out)
    return out
  }
  const safe = walk(value, 0) // walk maps undefined → null, so this is never undefined
  // The serialized payload travels as JSON through the answer POST, so run
  // it through JSON.stringify once here to enforce the wire cap and to fail
  // on any remaining unserializable value NOW rather than at the boundary.
  const json = JSON.stringify(safe) ?? 'null'
  if (json.length <= DOM_EVAL_RESULT_CAP) return safe
  return truncate(json, DOM_EVAL_RESULT_CAP)
}

async function collectEval(params: Record<string, unknown>): Promise<DomEvalResult> {
  const code = requireString(params, 'code')
  // Expression-first, mirroring console UX: bare `1+1` evaluates as an
  // expression; code with statements (return/const/…) only compiles in the
  // function-body form, which we fall back to on SyntaxError.
  let fn: (...args: unknown[]) => Promise<unknown>
  try {
    fn = new AsyncFunction(`return (\n${code}\n)`)
  } catch {
    fn = new AsyncFunction(code)
  }
  return { value: safeSerializeValue(await fn()) }
}

// --- dispatcher ---------------------------------------------------------------

/** Run one client-debug op against this tab's document. Throws presentable
 *  Error messages — the caller turns them into the answer's `error` string. */
export async function executeClientDebugOp(op: ClientDebugOp, params: Record<string, unknown>): Promise<unknown> {
  if (!params || typeof params !== 'object') throw new Error('params object is required')
  switch (op) {
    case 'dom_query':
      return collectDomQuery(params)
    case 'dom_computed_styles':
      return collectComputedStyles(params)
    case 'dom_screenshot':
      return collectScreenshot(params)
    case 'dom_eval':
      return collectEval(params)
    default:
      throw new Error(`unknown op ${JSON.stringify(String(op))}`)
  }
}
