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
export type ClientDebugOp = 'dom_query' | 'dom_computed_styles' | 'dom_screenshot' | 'dom_eval' | 'console_read'

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

export interface ConsoleReadParams {
  /** Minimum severity to return (`log` is recorded as `info`). */
  level?: ConsoleLevel
  /** Case-insensitive substring match against the joined, formatted args. */
  grep?: string
  /** Entry timestamp lower bound (ts >= since). */
  since?: number
  /** Keep the NEWEST N of the filtered entries. */
  limit?: number
}

/** Captured console severities, ASCENDING severity order. Single source for
 *  the ConsoleLevel type, the client executor's validation, the capture
 *  ring's severity comparison, and the server tool's zod enum — add a level
 *  here and nowhere else. */
export const CONSOLE_LEVELS = ['debug', 'info', 'warn', 'error'] as const

/** Severity of one captured console call / crash. `console.log` and
 *  `console.trace` map to `info` / `debug` respectively (see
 *  console-buffer's LEVEL_OF_METHOD). */
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number]

/** One captured console call (or uncaught crash — `error-capture.recordCrash`
 *  logs `[error-capture] <kind>: …` via console.error, which the hook
 *  captures as the crash's single ring entry). Args are stored AS PASSED:
 *  printf-style specifiers (%s/%d/…) are NOT interpolated, so greps should
 *  target the raw argument text, not what DevTools rendered. */
export interface ConsoleEntry {
  /** Monotonic per-tab sequence number, assigned at capture time. */
  seq: number
  /** Capture time (Date.now()). */
  ts: number
  level: ConsoleLevel
  /** Per-arg formatted strings (see formatConsoleArg). grep joins ONLY these
   *  — synthetic extras must never pollute the grep surface. */
  args: string[]
  /** console.trace only: the caller stack, capped at CONSOLE_ARG_CAP. Kept
   *  OUT of args (and thus out of grep and the entry's arg budget) so stack
   *  text can neither flood grep matches nor crowd out the real arguments. */
  stack?: string
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

export interface ConsoleReadResult {
  /** Filtered entries, oldest first. */
  entries: ConsoleEntry[]
  /** Entries currently in the ring (pre-filter). */
  total: number
  /** Entries evicted by the ring cap since install. */
  dropped: number
  /** Whether this tab has the capture ring installed at all — false for a
   *  production client bundle (install is dev-gated). console_read FAILS on
   *  such a tab rather than answering a successful empty, so the host
   *  broker's failure-grace window lets a healthy tab win; a successful
   *  result therefore always has captureEnabled true. Mirrors the server
   *  `logs` tool's `ringEnabled`. */
  captureEnabled: boolean
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

/** Per-arg formatted-string cap for a captured console call. */
export const CONSOLE_ARG_CAP = 2_000
/** Max args recorded per console call (trailing args beyond this are dropped). */
export const CONSOLE_ARGS_CAP = 16
/** Total formatted size cap per captured entry — mirrors server/log.ts's
 *  RING_LINE_MAX so one entry can never outweigh a server log line. */
export const CONSOLE_ENTRY_CAP = 4_096
/** Console ring buffer size (always-on capture, module installed at boot). */
export const CONSOLE_RING_CAP = 500
/** Default limit when a console_read query passes none — mirrors the server
 *  `logs` tool's default and bounds the answer size (≤200 × CONSOLE_ENTRY_CAP). */
export const CONSOLE_READ_DEFAULT_LIMIT = 200
