// Connection test: verify a token + baseUrl can reach the Anthropic API
// WITHOUT depending on the user having configured a valid model yet (the
// natural flow is token/URL first, model second).
//
// Two probe modes:
//   - sentinel (no `opts.model`): POST /v1/messages with a deliberately-
//     invalid sentinel model. Auth happens before the body's model is
//     validated, and the bogus model is rejected before any inference runs —
//     so this round-trips for free. Reached from POST /config/test-connection
//     (an API-level probe with no in-app caller today — the setup wizard has
//     no test button) and from POST /profiles/:id/test when the caller asks
//     for "no model".
//   - real model (`opts.model`, what the Profile card's Test button sends):
//     probe the model the user actually intends to run, bounded to 1
//     max_token. This DOES spend a (negligible) amount of inference, and is
//     the only probe that can tell "the provider serves this model" from "the
//     endpoint speaks the protocol" — a gateway answers 401 for a model it
//     cannot route, so the
//     sentinel alone cannot answer for a gateway.
//
// Classifying the response is the subtle part. The status code ALONE is not
// enough: the official API returns 404 `not_found_error` for an invalid
// model, while a mistyped Base URL ALSO returns 404 — but from a gateway, as
// HTML, not an Anthropic error envelope. Nor is the status trustworthy for
// auth: a gateway answers 401 for a model it has no provider for, so a bare
// 401 must not be read as "bad token" when the body says otherwise. Key on
// the BODY shape, then on the envelope's own error type:
//   - network error / timeout            → baseUrl unreachable
//   - structured envelope whose error
//     type is authentication_error        → token is wrong (any probe)
//   - real-model probe, structured
//     envelope, any other non-2xx         → reached the API, but it rejected
//     (the profile-test flow)                that model — name the model,
//                                            never the token (a 403 here is
//                                            model entitlement as often as
//                                            it is the key). A 429/5xx is
//                                            reported as provider-side, not
//                                            as a model verdict.
//   - sentinel probe, structured
//     envelope, permission_error          → token is wrong
//   - sentinel probe, structured
//     envelope, 401/403 other type         → AMBIGUOUS: gateways use this
//                                            shape for both a bad key and an
//                                            unroutable model. Say so, and
//                                            quote the provider's message.
//   - sentinel probe, structured
//     envelope with error.message,
//     other status                         → we reached the API: token+URL OK
//   - 401/403 with NO envelope             → token is wrong
//   - 404 with a non-API body (HTML,
//     empty, plain text)                   → wrong Base URL / path
//   - anything else                        → surface it verbatim (ambiguous)
//
// Extracted from config-routes.ts so both POST /config/test-connection and
// POST /profiles/:id/test share one classification path. The two probes do
// NOT answer the same question, though: the sentinel probe treats a structured
// bounce as success ("we reached the API"), while a real-model probe treats any
// non-2xx as a failure naming that model. Do not swap one caller onto the
// other's shape.

import { validateOutboundUrl } from './ssrf.js'
import { createLogger } from './log.js'

const log = createLogger('config-test')

const SENTINEL_MODEL = '__claude_react_web_connection_test__'

export interface TestConnectionResult {
  /** HTTP status to return to the client. Only SSRF failures surface a
   *  non-200 (400); every other branch (auth fail, success, 404, network
   *  error) returns 200 with the outcome encoded in the JSON body. The body
   *  is `{ ok: boolean, baseUrl, status?, error? }`; `error` is shown to the
   *  user verbatim, so it carries the provider's own message where one
   *  exists. */
  status: 200 | 400
  body: unknown
}

/** Run the probe against `baseUrl` with `token`. Never throws — network
 *  failures and SSRF rejections are folded into the result.
 *
 *  `opts.model` (the profile-test flow) probes the model the user actually
 *  intends to run instead of the sentinel, so the answer covers "can this
 *  provider serve this model", not just "does the endpoint speak the
 *  protocol". Omit it for the token+URL-first setup flow. */
export async function testConnection(
  token: string,
  baseUrl: string,
  opts?: { model?: string },
): Promise<TestConnectionResult> {
  // SSRF protection: reject private IPs, metadata endpoints, and
  // non-standard ports before making the outbound request.
  const ssrfCheck = await validateOutboundUrl(baseUrl)
  if (!ssrfCheck.ok) {
    return { status: 400, body: { ok: false, error: ssrfCheck.error } }
  }

  const model = opts?.model?.trim() || SENTINEL_MODEL
  const probeIsRealModel = model !== SENTINEL_MODEL

  log.info(`test-connection baseUrl=${baseUrl} model=${model}`)
  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
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

    // When the endpoint answered with a structured Anthropic-style envelope,
    // classify on the envelope. A real-model probe (the profile-test flow)
    // names the model in every rejection: with a specific model on the wire,
    // an auth-shaped error (403 permission_error especially) is just as
    // likely to be about MODEL entitlement as about the key, so "Invalid auth
    // token" is a claim we cannot make honestly there.
    if (envelope) {
      if (res.ok) return { status: 200, body: { ok: true, baseUrl } }
      // `authentication_error` is by definition about the credential, so it is
      // reported as such even on a real-model probe: that is the one
      // unambiguous auth verdict available from an envelope.
      if (errType === 'authentication_error') {
        return {
          status: 200,
          body: {
            ok: false, status: res.status, baseUrl,
            error: errMsg ? `Invalid auth token: ${errMsg}` : 'Invalid auth token',
          },
        }
      }
      // With a specific model on the wire, every other rejection is at least
      // as likely to be about the model (403 `permission_error` especially,
      // which also covers model entitlement) as about the key — so name the
      // model instead of asserting the credential is bad.
      if (probeIsRealModel) {
        // Rate limits and provider-side failures are NOT a model verdict:
        // credentials, URL and model were all accepted, the provider just
        // couldn't serve the request. Say that, so the user does not go
        // deleting a working model over a transient 429.
        const providerSide = res.status === 429 || res.status >= 500
        return {
          status: 200,
          body: {
            ok: false, status: res.status, baseUrl,
            error: providerSide
              ? `Reached the API with model ${model}, but the provider returned HTTP ${res.status}`
                + (errMsg ? `: ${errMsg}` : '') + ' — the credentials and model were accepted'
              : `Reached the API with model ${model}, but it rejected the request`
                + (errMsg ? `: ${errMsg}` : ` (HTTP ${res.status})`),
          },
        }
      }
      if (errType === 'permission_error') {
        return {
          status: 200,
          body: {
            ok: false, status: res.status, baseUrl,
            error: errMsg ? `Invalid auth token: ${errMsg}` : 'Invalid auth token',
          },
        }
      }
      if (res.status === 401 || res.status === 403) {
        // The sentinel probe on a bare 401/403 is genuinely ambiguous and NOT
        // decidable from the envelope: a third-party gateway answers this
        // exact shape both for a bad key ("API Key 不存在") and for a model it
        // has no provider for ("该模型未指定供应商") — verified against a live
        // gateway. So do not invent a verdict; hand the provider's own words
        // to the user alongside the credential-shaped reading. (The sentinel
        // id stays out of the message: it is an internal placeholder, not
        // something the user can act on.)
        return {
          status: 200,
          body: {
            ok: false, status: res.status, baseUrl,
            error: `Could not verify these credentials (HTTP ${res.status})`
              + (errMsg ? `: ${errMsg}` : '')
              + ' — the key may be invalid, or the endpoint may be rejecting the probe request',
          },
        }
      }
      // Sentinel probe on a non-auth status: a structured response carrying an
      // error message means we authenticated and the API processed the request
      // — which is what "is this token + URL usable" asks. The sentinel model
      // bouncing (400 on a proxy, 404 not_found on the official API) lands
      // here. (An envelope without `error.message` — e.g. an OpenAI-shaped
      // `{detail}` body — keeps the pre-existing fall-through behaviour.)
      if (errMsg) return { status: 200, body: { ok: true, baseUrl } }
    }

    // No structured envelope — the status is all we have, so read it
    // literally. A proxy that strips error bodies still lands here.
    if (res.status === 401 || res.status === 403) {
      return { status: 200, body: { ok: false, status: res.status, error: 'Invalid auth token', baseUrl } }
    }
    if (res.ok) return { status: 200, body: { ok: true, baseUrl } }

    // A 404 with a non-API body is a mistyped Base URL hitting a gateway.
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
