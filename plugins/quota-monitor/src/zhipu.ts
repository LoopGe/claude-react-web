// Zhipu GLM (智谱) quota adapter — ported from cc-switch's query_zhipu /
// zhipu_quota_from_body / parse_zhipu_token_tiers.
//
// Endpoint lives on the same host as the user's coding endpoint
// (open.bigmodel.cn or api.z.ai). Auth is the raw API key — Zhipu does NOT
// want a `Bearer ` prefix.

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

function quotaBase(baseUrl: string): string {
  return baseUrl.toLowerCase().includes('bigmodel.cn')
    ? 'https://open.bigmodel.cn'
    : 'https://api.z.ai'
}

type WindowEntry = { resetMs: number | null; percentage: number; resetsAt: string | null }

function classifyWindowUnit(unit: unknown): 'five_hour' | 'weekly' | null {
  if (num(unit) === 3) return TIER_FIVE_HOUR
  if (num(unit) === 6) return TIER_WEEKLY
  return null
}

/** Parse Zhipu `data.limits[]` into tiers.
 *  1. Explicit `unit` field identifies the window (3 = five_hour, 6 = weekly).
 *     Do NOT sort by nextResetTime instead — at the end of a period the weekly
 *     window resets before the 5-hour window, and time-sorting mislabels them.
 *  2. Fallback heuristic when `unit` is absent/unknown: entries without a
 *     reset time are treated as five_hour first, the rest fill slots in reset
 *     order. Old plans return a single TOKENS_LIMIT → degrades to five_hour
 *     only. */
export function parseZhipuTiers(data: unknown): QuotaTier[] {
  const fiveHour: WindowEntry[] = []
  const weekly: WindowEntry[] = []
  const unclassified: WindowEntry[] = []
  if (!data || typeof data !== 'object') return []
  const d = data as Record<string, unknown>
  const limits = Array.isArray(d.limits) ? d.limits : []
  for (const item of limits) {
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const type = typeof it.type === 'string' ? it.type.toLowerCase() : ''
    if (type !== 'tokens_limit' && type !== 'credit_limit') {
      continue
    }
    const percentage = num(it.percentage) ?? 0
    const resetMs = num(it.nextResetTime) ?? null
    const entry: WindowEntry = { resetMs, percentage, resetsAt: epochToIso(it.nextResetTime) }
    const slot = classifyWindowUnit(it.unit)
    if (slot === TIER_FIVE_HOUR) fiveHour.push(entry)
    else if (slot === TIER_WEEKLY) weekly.push(entry)
    else unclassified.push(entry)
  }

  // Fill empty slots from unclassified, entries without reset first, then by
  // ascending reset time.
  unclassified.sort((a, b) => {
    if (a.resetMs === null && b.resetMs !== null) return -1
    if (a.resetMs !== null && b.resetMs === null) return 1
    return (a.resetMs ?? 0) - (b.resetMs ?? 0)
  })
  for (const entry of unclassified) {
    if (fiveHour.length === 0) fiveHour.push(entry)
    else if (weekly.length === 0) weekly.push(entry)
  }

  const tiers: QuotaTier[] = []
  for (const [name, entries] of [
    [TIER_FIVE_HOUR, fiveHour],
    [TIER_WEEKLY, weekly],
  ] as const) {
    for (const e of entries.slice(0, 1)) {
      tiers.push({ name, label: WINDOW_LABELS[name], utilization: e.percentage, resets_at: e.resetsAt })
    }
  }
  return tiers
}

async function queryZhipu(http: HttpClient, baseUrl: string, apiKey: string): Promise<PlatformQueryResult> {
  const url = `${quotaBase(baseUrl)}/api/monitor/usage/quota/limit`

  let res
  try {
    res = await http.request({
      url,
      method: 'GET',
      headers: {
        Authorization: apiKey, // NOTE: no Bearer prefix for Zhipu
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en',
      },
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
  if (!body || typeof body !== 'object') {
    return { data: null, error: { kind: 'soft', message: 'Malformed response body' } }
  }
  const b = body as Record<string, unknown>
  if (b.success === false) {
    const msg = typeof b.msg === 'string' ? b.msg : 'Unknown error'
    return { data: null, error: { kind: 'soft', message: `API error: ${msg}` } }
  }
  if (!b.data || typeof b.data !== 'object') {
    return { data: null, error: { kind: 'soft', message: "Missing 'data' field in response" } }
  }
  const data = b.data as Record<string, unknown>
  const tiers = parseZhipuTiers(data)
  const planType = typeof data.level === 'string' ? data.level : null
  return {
    data: { planKind: 'subscription', planType, tiers },
    error: null,
  }
}

export const zhipuAdapter: PlatformAdapter = {
  id: 'zhipu',
  label: 'Zhipu',
  isConfigured: (cfg) => Boolean(cfg.zhipuApiKey),
  query: (http, cfg) => queryZhipu(http, cfg.zhipuBaseUrl, cfg.zhipuApiKey),
}