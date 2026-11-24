/** Per-(session,file) PDF view-state retention.
 *
 * Builder call (Task 4): an IN-MEMORY module store, not localStorage and not
 * the session-store mirror. The state is an ephemeral viewing preference —
 * DSH parity: it survives body unmounts (resource-tab switches, panel switches,
 * modal close/reopen) and is forgotten when the tab closes. A page reload
 * resets it, which is correct for a preference about a transient reading
 * position; localStorage would persist it past the tab's lifetime and need
 * quota/cleanup machinery, and the transcript mirror is durable conversation
 * state, the wrong home for UI chrome.
 *
 * Keys are opaque strings; the resource host uses the file resource address
 * (`crw-resource://file/<sessionId>/<path>` — the (session,file) identity), so
 * two sessions previewing the same path retain independent state. The tab
 * store's lifecycle observer calls `forgetPdfViewState` on tab close and
 * session removal (wired in ResourcePaneProvider). */

/** One file's last visible page and zoom preference; absent zoom = fit-width. */
export interface PdfViewState {
  readonly page: number
  readonly zoom?: number
}

const states = new Map<string, PdfViewState>()

export function recallPdfViewState(key: string): PdfViewState | undefined {
  return states.get(key)
}

/** Record the page the reader reached (1-based). */
export function rememberPdfPage(key: string, page: number): void {
  states.set(key, { ...states.get(key), page })
}

/** Record the settled zoom; `undefined` selects fit-width (clears a fixed scale). */
export function rememberPdfZoom(key: string, zoom: number | undefined): void {
  const previous = states.get(key)
  states.set(key, zoom === undefined ? { page: previous?.page ?? 1 } : { page: previous?.page ?? 1, zoom })
}

/** Discard a file's view state — the owning tab closed. */
export function forgetPdfViewState(key: string): void {
  states.delete(key)
}
