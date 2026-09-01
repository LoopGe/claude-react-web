// Kimi (Moonshot) quota adapter — ported from cc-switch's query_kimi.
//
// Endpoint: GET https://api.kimi.com/coding/v1/usages with `Authorization:
// Bearer <api key>`. Response shape:
//   {
//     "limits": [ { "detail": { "limit", "remaining", "resetTime" } }, ... ],  // 5-hour windows
//     "usage":  { "limit", "remaining", "resetTime" }                          // weekly window
//   }
// utilization = (limit - remaining) / limit * 100, floored at 0.

import {
  TIER_FIVE_HOUR,
  TIER_WEEKLY,
  WINDOW_LABELS,
  epochToIso,
  num,
  type HttpClient,
  type PlatformAdapter,
  type PlatformQueryResult,
  type QuotaTier,
} from './platform.js'

const KIMI_URL = 'https://api.kimi.com/coding/v1/usages'

function tierFromLimitDetail(detail: unknown, name: string): QuotaTier | null {
  if (!detail || typeof detail !== 'object') return null
  const d = detail as Record<string, unknown>
  const limit = num(d.limit) ?? 1
  const remaining = num(d.remaining) ?? 0
  const used = Math.max(0, limit - remaining)
  const utilization = limit > 0 ? (used / limit) * 100 : 0
  return {
    name,
    label: WINDOW_LABELS[name],
    utilization,
    resets_at: epochToIso(d.resetTime),
    used,
    quota: limit,
  }
}

export function parseKimiTiers(body: unknown): QuotaTier[] {
  const tiers: QuotaTier[] = []
  if (!body || typeof body !== 'object') return tiers
  const b = body as Record<string, unknown>

  // `limits[]` can carry several 5-hour window entries — take only the first
  // so the stat-grid row id (`kimi_five_hour`) stays unique.
  if (Array.isArray(b.limits)) {
    for (const item of b.limits) {
      if (!item || typeof item !== 'object') continue
      const tier = tierFromLimitDetail((item as Record<string, unknown>).detail, TIER_FIVE_HOUR)
      if (tier) {
        tiers.push(tier)
        break
      }
    }
  }
  const weekly = tierFromLimitDetail(b.usage, TIER_WEEKLY)
  if (weekly) tiers.push(weekly)
  return tiers
}

async function queryKimi(http: HttpClient, apiKey: string): Promise<PlatformQueryResult> {
  let res
  try {
    res = await http.request({
      url: KIMI_URL,
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeoutMs: 15_000,
    })
  } catch (err) {
    return { data: null, error: { kind: 'transient', message: `Network error: ${(err as Error).message}` } }
  }

  if (res.status === 401 || res.status === 403) {
    return {
      data: null,
      error: { kind: 'auth', message: `Authentication failed (HTTP ${res.status}): invalid API key` },
    }
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

  const tiers = parseKimiTiers(body)
  if (tiers.length === 0) {
    return { data: null, error: { kind: 'soft', message: 'Response did not contain usable quota windows' } }
  }
  return { data: { planKind: 'subscription', planType: null, tiers }, error: null }
}

export const kimiAdapter: PlatformAdapter = {
  id: 'kimi',
  label: 'Kimi',
  isConfigured: (cfg) => Boolean(cfg.kimiApiKey),
  query: (http, cfg) => queryKimi(http, cfg.kimiApiKey),
}