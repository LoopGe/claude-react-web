// ZenMux quota adapter — ported from cc-switch's query_zenmux.
//
// ZenMux points at the user's configured Zen relay base URL; the response is
// `{ success, message, data: { plan: { tier }, account_status,
// quota_5_hour: { usage_percentage (0-1), resets_at, used_value_usd,
// max_value_usd }, quota_7_day: {...} } }`. utilization = usage_percentage*100.
//
// NETWORK NOTE: like the generic adapter this reaches a user-configured host
// (the Zen base URL can be any gateway), so it uses a DIRECT fetch rather than
// the host's network.fetch broker. See generic.ts for the trust-model rationale.

import {
  TIER_FIVE_HOUR,
  TIER_WEEKLY,
  WINDOW_LABELS,
  parseResetTime,
  num,
  type HttpClient,
  type PlatformAdapter,
  type PlatformQueryResult,
  type QuotaTier,
} from './platform.js'

export function parseZenmuxTiers(data: unknown): QuotaTier[] {
  const tiers: QuotaTier[] = []
  if (!data || typeof data !== 'object') return tiers
  const d = data as Record<string, unknown>

  const q5h = d.quota_5_hour
  if (q5h && typeof q5h === 'object') {
    const w = q5h as Record<string, unknown>
    const pct = num(w.usage_percentage) ?? 0
    tiers.push({
      name: TIER_FIVE_HOUR,
      label: WINDOW_LABELS[TIER_FIVE_HOUR],
      utilization: pct * 100,
      resets_at: parseResetTime(w.resets_at),
    })
  }
  const q7d = d.quota_7_day
  if (q7d && typeof q7d === 'object') {
    const w = q7d as Record<string, unknown>
    const pct = num(w.usage_percentage) ?? 0
    tiers.push({
      name: TIER_WEEKLY,
      label: WINDOW_LABELS[TIER_WEEKLY],
      utilization: pct * 100,
      resets_at: parseResetTime(w.resets_at),
    })
  }
  return tiers
}

function planInfo(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const plan = d.plan && typeof d.plan === 'object' ? (d.plan as Record<string, unknown>) : {}
  const tier = typeof plan.tier === 'string' ? plan.tier.trim() : ''
  const status = typeof d.account_status === 'string' ? d.account_status.trim() : ''
  if (!tier && !status) return null
  if (tier && status) return `${tier} (${status})`
  return tier || status
}

async function queryZenmux(http: HttpClient, baseUrl: string, apiKey: string): Promise<PlatformQueryResult> {
  let res
  try {
    res = await http.request({
      url: baseUrl,
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeoutMs: 15_000,
    })
  } catch (err) {
    return { data: null, error: { kind: 'transient', message: `Network error: ${(err as Error).message}` } }
  }

  if (res.status === 401 || res.status === 403) {
    return { data: null, error: { kind: 'auth', message: `Authentication failed (HTTP ${res.status}): invalid token` } }
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
  if (!body || typeof body !== 'object') {
    return { data: null, error: { kind: 'soft', message: 'Malformed response body' } }
  }
  const b = body as Record<string, unknown>
  if (b.success !== true) {
    const msg = typeof b.message === 'string' ? b.message : 'Unknown error'
    return { data: null, error: { kind: 'soft', message: `API error: ${msg}` } }
  }
  if (!b.data || typeof b.data !== 'object') {
    return { data: null, error: { kind: 'soft', message: "Missing 'data' field in response" } }
  }

  const tiers = parseZenmuxTiers(b.data)
  if (tiers.length === 0) {
    return { data: null, error: { kind: 'soft', message: 'Response did not contain usable quota windows' } }
  }
  return { data: { planKind: 'subscription', planType: planInfo(b.data), tiers }, error: null }
}

export const zenmuxAdapter: PlatformAdapter = {
  id: 'zenmux',
  label: 'ZenMux',
  isConfigured: (cfg) => Boolean(cfg.zenmuxUrl.trim() && cfg.zenmuxApiKey),
  query: (http, cfg) => queryZenmux(http, cfg.zenmuxUrl, cfg.zenmuxApiKey),
}