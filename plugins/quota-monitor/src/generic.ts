// Generic endpoint adapter — a catch-all for relays / proxies that expose a
// balance or usage endpoint (e.g. `/usage`, `/balance`) and accept a Bearer
// token. The user supplies the full URL; this adapter tolerantly parses the
// most common response shapes:
//
//   Balance (OpenAI-style): { total_balance, grant_balance, topped_up_balance }
//                           { data: { total_balance } }  { balance }  { credits }
//   Subscription windows:   { five_hour: { percent }, weekly: { used, quota }, ... }
//
// NETWORK NOTE: unlike the built-in platforms this adapter does NOT go
// through the host's `network.fetch` broker (whose host allowlist is fixed in
// the manifest). A generic URL can point at any host, so it uses a direct
// fetch. The plugin subprocess is a trusted local program (the App Plugin
// trust model explicitly allows bypassing the broker), so this is safe by
// design — but it means generic endpoints are NOT audited/consented via the
// permission system.

import {
  TIER_FIVE_HOUR,
  TIER_WEEKLY,
  TIER_MONTHLY,
  TIER_DAILY,
  WINDOW_LABELS,
  parseResetTime,
  num,
  type HttpClient,
  type PlatformAdapter,
  type PlatformQueryResult,
  type QuotaTier,
} from './platform.js'

/** Window names by which a generic response may label its buckets. */
const WINDOW_KEYS: Record<string, string> = {
  five_hour: TIER_FIVE_HOUR,
  fivehour: TIER_FIVE_HOUR,
  '5h': TIER_FIVE_HOUR,
  rolling: TIER_FIVE_HOUR,
  weekly: TIER_WEEKLY,
  week: TIER_WEEKLY,
  '7d': TIER_WEEKLY,
  monthly: TIER_MONTHLY,
  month: TIER_MONTHLY,
  daily: TIER_DAILY,
  day: TIER_DAILY,
}

/** Extract a utilization 0–100 from one window object (percent or used/quota). */
function windowUtilization(obj: Record<string, unknown>): number | null {
  const pct = num(obj.percent ?? obj.percentage ?? obj.utilization ?? obj.usedPercent ?? obj.usagePercent)
  if (pct !== undefined) return pct
  const used = num(obj.used ?? obj.usedValue)
  const quota = num(obj.quota ?? obj.limit ?? obj.max ?? obj.total)
  if (used !== undefined && quota !== undefined && quota > 0) return (used / quota) * 100
  return null
}

/** Tolerant window extraction across the whole response body. */
export function parseGenericWindows(body: unknown): QuotaTier[] {
  const tiers: QuotaTier[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    for (const [key, value] of Object.entries(obj)) {
      const name = WINDOW_KEYS[key.toLowerCase()]
      if (name && value && typeof value === 'object' && !Array.isArray(value)) {
        const w = value as Record<string, unknown>
        const utilization = windowUtilization(w)
        if (utilization !== null) {
          tiers.push({
            name,
            label: WINDOW_LABELS[name],
            utilization,
            resets_at: parseResetTime(w.resetsAt ?? w.resetTime ?? w.reset_time),
            used: num(w.used ?? w.usedValue),
            quota: num(w.quota ?? w.limit ?? w.max ?? w.total),
          })
        }
      }
      // Recurse into nested containers (arrays, objects) to find windows.
      if (value && typeof value === 'object') walk(value)
    }
  }
  walk(body)
  // De-duplicate by window name — keep the first (top-most) hit.
  const seen = new Set<string>()
  return tiers.filter((t) => {
    if (seen.has(t.name)) return false
    seen.add(t.name)
    return true
  })
}

/** Extract a scalar balance from the common OpenAI-style relay shapes. */
export function parseBalance(body: unknown): { amount: number; currency?: string } | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const data = b.data && typeof b.data === 'object' ? (b.data as Record<string, unknown>) : {}

  // 1. total_balance family (OpenAI relay convention).
  const total =
    num(b.total_balance) ?? num(data.total_balance) ?? num(b.balance) ?? num(data.balance) ?? num(b.credits)
  if (total !== undefined) {
    const currency =
      (typeof b.currency === 'string' && b.currency) ||
      (typeof data.currency === 'string' && data.currency) ||
      undefined
    return { amount: total, currency }
  }
  return null
}

async function queryGeneric(http: HttpClient, opts: {
  url: string
  method: 'GET' | 'POST'
  token: string
}): Promise<PlatformQueryResult> {
  if (!opts.url) {
    return { data: null, error: { kind: 'soft', message: 'No generic endpoint URL configured' } }
  }

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`

  let res
  try {
    res = await http.request({
      url: opts.url,
      method: opts.method,
      headers,
      timeoutMs: 15_000,
    })
  } catch (err) {
    return { data: null, error: { kind: 'transient', message: `Network error: ${(err as Error).message}` } }
  }

  if (res.status === 401 || res.status === 403) {
    return {
      data: null,
      error: { kind: 'auth', message: `Authentication failed (HTTP ${res.status}): invalid token` },
    }
  }
  if (!res.status.toString().startsWith('2')) {
    return {
      data: null,
      error: { kind: 'soft', message: `API error (HTTP ${res.status}): ${res.body.slice(0, 300)}` },
    }
  }

  let body: unknown
  try {
    body = JSON.parse(res.body)
  } catch {
    return { data: null, error: { kind: 'soft', message: 'Failed to parse response as JSON' } }
  }

  const balance = parseBalance(body)
  if (balance) {
    return {
      data: {
        planKind: null,
        planType: null,
        tiers: [],
        balance,
      },
      error: null,
    }
  }

  const tiers = parseGenericWindows(body)
  if (tiers.length > 0) {
    return { data: { planKind: 'subscription', planType: null, tiers }, error: null }
  }

  return {
    data: null,
    error: {
      kind: 'soft',
      message: `Unsupported response shape: ${res.body.slice(0, 200)}`,
    },
  }
}

export const genericAdapter: PlatformAdapter = {
  id: 'generic',
  label: 'Relay',
  isConfigured: (cfg) => Boolean(cfg.genericUrl.trim()),
  query: (http, cfg) =>
    queryGeneric(http, {
      url: cfg.genericUrl,
      method: cfg.genericMethod,
      token: cfg.genericBearerToken,
    }),
}