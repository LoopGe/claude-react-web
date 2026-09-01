// OpenCode Go quota adapter — ported from cc-switch's query_opencode_go /
// parse_opencode_go_tiers.
//
// Endpoint: GET https://opencode.ai/zen/go/v1/usage with `Authorization:
// Bearer <key>` (the usage endpoint wants Bearer, unlike the inference side
// which uses x-api-key — they are not interchangeable). Response:
//   { "usage": { "rolling"|"weekly"|"monthly": { "status", "percent" (0-100,
//     used), "resetsAt" (ISO) } } }
// percent==0 carries a placeholder resetsAt (now+window), so it is dropped.

import {
  TIER_FIVE_HOUR,
  TIER_WEEKLY,
  TIER_MONTHLY,
  WINDOW_LABELS,
  parseResetTime,
  num,
  type HttpClient,
  type PlatformAdapter,
  type PlatformQueryResult,
  type QuotaTier,
} from './platform.js'

const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

export function parseOpenCodeGoTiers(body: unknown): QuotaTier[] {
  const tiers: QuotaTier[] = []
  if (!body || typeof body !== 'object') return tiers
  const usage = (body as Record<string, unknown>).usage
  if (!usage || typeof usage !== 'object') return tiers
  const u = usage as Record<string, unknown>
  for (const [key, name] of [
    ['rolling', TIER_FIVE_HOUR],
    ['weekly', TIER_WEEKLY],
    ['monthly', TIER_MONTHLY],
  ] as const) {
    const window = u[key]
    if (!window || typeof window !== 'object') continue
    const w = window as Record<string, unknown>
    const percent = num(w.percent)
    if (percent === undefined) continue
    tiers.push({
      name,
      label: WINDOW_LABELS[name],
      utilization: percent,
      // percent==0 → upstream resetsAt is a placeholder; do not show a countdown.
      resets_at: percent > 0 ? parseResetTime(w.resetsAt) : null,
    })
  }
  return tiers
}

async function queryOpenCodeGo(http: HttpClient, apiKey: string): Promise<PlatformQueryResult> {
  let res
  try {
    res = await http.request({
      url: GO_USAGE_URL,
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeoutMs: 15_000,
    })
  } catch (err) {
    return { data: null, error: { kind: 'transient', message: `Network error: ${(err as Error).message}` } }
  }

  if (res.status === 403) {
    // 403 EntitlementError: the key is valid (Zen & Go share a workspace key)
    // but this workspace has no Go subscription — distinguish from auth failure.
    return { data: null, error: { kind: 'soft', message: 'API key is valid but has no OpenCode Go subscription (HTTP 403)' } }
  }
  if (res.status === 401) {
    return { data: null, error: { kind: 'auth', message: 'Authentication failed (HTTP 401): invalid API key' } }
  }
  if (!res.status.toString().startsWith('2')) {
    return { data: null, error: { kind: 'soft', message: `API error (HTTP ${res.status}): ${res.body.slice(0, 300)}` } }
  }

  let body: unknown
  try {
    body = JSON.parse(res.body)
  } catch {
    return { data: null, error: { kind: 'soft', message: 'Failed to parse response' } }
  }

  const tiers = parseOpenCodeGoTiers(body)
  if (tiers.length === 0) {
    return { data: null, error: { kind: 'soft', message: 'Response did not contain usable usage windows' } }
  }
  return { data: { planKind: 'subscription', planType: null, tiers }, error: null }
}

export const opencodeGoAdapter: PlatformAdapter = {
  id: 'opencodeGo',
  label: 'OpenCode Go',
  isConfigured: (cfg) => Boolean(cfg.opencodeGoApiKey),
  query: (http, cfg) => queryOpenCodeGo(http, cfg.opencodeGoApiKey),
}