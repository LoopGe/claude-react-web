// Connection test: verify a token + baseUrl can reach the Anthropic API
// WITHOUT depending on the user having configured a valid model yet (the
// natural flow is token/URL first, model second) and WITHOUT spending tokens.
//
// The trick: POST /v1/messages with a deliberately-invalid sentinel model.
// Auth happens before the body's model is validated, and the bogus model is
// rejected before any inference runs — so this round-trips for free.
//
// Classifying the response is the subtle part. The status code ALONE is not
// enough: the official API returns 404 `not_found_error` for an invalid
// model, while a mistyped Base URL ALSO returns 404 — but from a gateway, as
// HTML, not an Anthropic error envelope. So we key on the BODY shape:
//   - network error / timeout            → baseUrl unreachable
//   - auth rejection (401/403, or an
//     Anthropic authentication/permission
//     error type)                        → token is wrong
//   - a structured API response (2xx, OR
//     a JSON error envelope with an
//     error.message — incl. our sentinel
//     model bouncing as 400/404)         → we reached the API: token + URL OK
//   - 404 with a non-API body (HTML,
//     empty, plain text)                 → wrong Base URL / path
//   - anything else                      → surface it verbatim (ambiguous)
//
// Extracted from config-routes.ts so both POST /config/test-connection and
// POST /profiles/:id/test share one classification path and produce the
// identical observable response for the same token/baseUrl.

import { validateOutboundUrl } from './ssrf.js'
import { createLogger } from './log.js'

const log = createLogger('config-test')

const SENTINEL_MODEL = '__claude_react_web_connection_test__'

export interface TestConnectionResult {
  /** HTTP status to return to the client. Only SSRF failures surface a
   *  non-200 (400); every other branch (auth fail, success, 404, network
   *  error) returns 200 with the outcome encoded in the JSON body — this
   *  matches the original /config/test-connection behavior byte-for-byte. */
  status: 200 | 400
  body: unknown
}

/** Run the sentinel-model probe against `baseUrl` with `token`. Never throws
 *  — network failures and SSRF rejections are folded into the result. */
export async function testConnection(token: string, baseUrl: string): Promise<TestConnectionResult> {
  // SSRF protection: reject private IPs, metadata endpoints, and
  // non-standard ports before making the outbound request.
  const ssrfCheck = await validateOutboundUrl(baseUrl)
  if (!ssrfCheck.ok) {
    return { status: 400, body: { ok: false, error: ssrfCheck.error } }
  }

  log.info(`test-connection baseUrl=${baseUrl}`)
  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: SENTINEL_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(15_000),
    })

    // Parse the body once. An Anthropic-compatible API (official or proxy)
    // answers errors as JSON `{ error: { type?, message } }`; a misrouted
    // request hits a gateway that answers with HTML or plain text.
    const text = await res.text().catch(() => '')
    let envelope: { error?: { type?: string; message?: string } } | null = null
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') envelope = parsed
    } catch { /* non-JSON body (e.g. gateway HTML) */ }
    const errType = envelope?.error?.type
    const errMsg = envelope?.error?.message

    // Auth failure: trust the HTTP status (401/403) and the Anthropic error
    // type. These are decided before the model is looked at.
    if (res.status === 401 || res.status === 403
      || errType === 'authentication_error' || errType === 'permission_error') {
      return { status: 200, body: { ok: false, status: res.status, error: 'Invalid auth token', baseUrl } }
    }

    // A 2xx, or any structured Anthropic-style error (has error.message),
    // means we authenticated and the API processed the request — which is
    // exactly what "is this token + URL usable" asks. The sentinel model
    // bouncing (400 on the proxy, 404 not_found on the official API) lands
    // here.
    if (res.ok || errMsg) {
      return { status: 200, body: { ok: true, baseUrl } }
    }

    // No API envelope. A 404 here is a mistyped Base URL hitting a gateway.
    if (res.status === 404) {
      return { status: 200, body: { ok: false, status: 404, error: 'Endpoint not found — check the Base URL', baseUrl } }
    }

    // Anything else (e.g. a 5xx HTML gateway error) is ambiguous — surface
    // the status so the user can diagnose it.
    return { status: 200, body: { ok: false, status: res.status, error: `Unexpected response (HTTP ${res.status})`, baseUrl } }
  } catch (e) {
    const err = e as Error
    const msg = err.name === 'TimeoutError' || err.name === 'AbortError'
      ? 'Request timed out after 15s'
      : `Could not reach ${baseUrl} (${err.message || 'network error'})`
    log.warn(`test-connection failed: ${msg}`)
    return { status: 200, body: { ok: false, error: msg, baseUrl } }
  }
}
