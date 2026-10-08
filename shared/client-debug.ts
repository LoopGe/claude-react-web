// Browser-safe types for the dev-only `appdebug` client-debug channel.
//
// The host process cannot see the DOM — it lives in the connected browser
// tabs. When one of the `mcp__appdebug__dom_*` tools runs, the host
// broadcasts a `client-debug-request` WS frame to every connected tab; the
// FIRST tab to answer (via POST /client-debug/:id/answer) wins. This file
// defines the op vocabulary and answer shape shared by server and client
// with no SDK dependency.
//
// Security posture (see server/sdk-tools/app-debug.ts): dev-mode-only
// reachability, read-only ops auto-approved by the permission broker,
// `dom_eval` prompts like any other tool.

/** The ops the browser executor implements. Kept a closed union — the
 *  client executor switches on it and must reject unknown values. */
export type ClientDebugOp = 'dom_query' | 'dom_computed_styles' | 'dom_screenshot' | 'dom_eval'

// --- op params (client-side validation is the authority; these document
// --- the contract and type the tool definitions) --------------------------

export interface DomQueryParams {
  /** CSS selector, evaluated against the answering tab's document. */
  selector: string
  /** Cap on returned nodes (default 10). */
  maxNodes?: number
  /** Include truncated outerHTML per node (default true). */
  includeHtml?: boolean
}

export interface DomComputedStylesParams {
  selector: string
  /** First matched element only. */
  properties?: string[]
}

export interface DomScreenshotParams {
  /** Omit to capture the whole viewport (documentElement). */
  selector?: string
}

export interface DomEvalParams {
  /** JavaScript source, evaluated as an async function body in page context. */
  code: string
}

// --- results ---------------------------------------------------------------

/** One matched node of a dom_query result. */
export interface ClientDebugNode {
  tag: string
  id?: string
  classes?: string[]
  text?: string
  /** Truncated outerHTML (per-node cap applied client-side). */
  html?: string
}

export interface DomQueryResult {
  /** document.querySelectorAll hit count (may exceed the returned nodes). */
  total: number
  nodes: ClientDebugNode[]
}

export interface DomComputedStylesResult {
  tag: string
  id?: string
  classes?: string[]
  styles: Record<string, string>
}

export interface DomScreenshotResult {
  /** PNG data URL (`data:image/png;base64,...`). */
  dataUrl: string
  width: number
  height: number
}

export interface DomEvalResult {
  /** JSON-safe serialization of the evaluated value. */
  value: unknown
}

/** The browser's answer to one client-debug request. */
export type ClientDebugAnswer = { ok: true; result: unknown } | { ok: false; error: string }

// --- result-size caps (applied client-side before the answer is POSTed) ----

/** Per-node outerHTML cap for dom_query. */
export const DOM_QUERY_HTML_CAP = 50_000
/** dom_query text cap per node. */
export const DOM_QUERY_TEXT_CAP = 4_000
/** dom_eval serialized-result cap. */
export const DOM_EVAL_RESULT_CAP = 100_000
/** dom_screenshot PNG data-URL cap. */
export const DOM_SCREENSHOT_URL_CAP = 2_000_000
