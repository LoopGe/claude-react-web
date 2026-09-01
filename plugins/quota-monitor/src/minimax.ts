// MiniMax (海螺) quota adapter — ported from cc-switch's query_minimax /
// parse_minimax_tiers.
//
// Endpoint: GET https://api.minimaxi.com (CN) / api.minimax.io (intl)
//   /v1/api/openplatform/coding_plan/remains, `Authorization: Bearer <key>`.
// The new API reports REMAINING percentages (0-100); utilization is inverted.
// Only the `general` model entry is used (skip video etc.). The weekly bucket
// exists only when current_weekly_status == 1 (a plan without a weekly limit
// reports status 3 with remaining pinned at 100 and must not be shown).

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

export function parseMinimaxTiers(body: unknown): QuotaTier[] {
  const tiers: QuotaTier[] = []
  if (!body || typeof body !== 'object') return tiers
  const b = body as Record<string, unknown>
  const remains = Array.isArray(b.model_remains) ? b.model_remains : []
  const item = remains.find((it) => {
    if (!it || typeof it !== 'object') return false
    return (it as Record<string, unknown>).model_name === 'general'
  })
  if (!item || typeof item !== 'object') return tiers
  const g = item as Record<string, unknown>

  const intervalRemain = num(g.current_interval_remaining_percent)
  if (intervalRemain !== undefined) {
    tiers.push({
      name: TIER_FIVE_HOUR,
      label: WINDOW_LABELS[TIER_FIVE_HOUR],
      utilization: 100 - intervalRemain,
      resets_at: epochToIso(g.end_time),
    })
  }

  if (num(g.current_weekly_status) === 1) {
    const weeklyRemain = num(g.current_weekly_remaining_percent)
    if (weeklyRemain !== undefined) {
      tiers.push({
        name: TIER_WEEKLY,
        label: WINDOW_LABELS[TIER_WEEKLY],
        utilization: 100 - weeklyRemain,
        resets_at: epochToIso(g.weekly_end_time),
      })
    }
  }
  return tiers
}

async function queryMinimax(http: HttpClient, apiKey: string, region: 'cn' | 'intl'): Promise<PlatformQueryResult> {
  const host = region === 'cn' ? 'api.minimaxi.com' : 'api.minimax.io'
  const url = `https://${host}/v1/api/openplatform/coding_plan/remains`

  let res
  try {
    res = await http.request({
      url,
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeoutMs: 15_000,
    })
  } catch (err) {
    return { data: null, error: { kind: 'transient', message: `Network error: ${(err as Error).message}` } }
  }

  if (res.status === 401 || res.status === 403) {
    return { data: null, error: { kind: 'auth', message: `Authentication failed (HTTP ${res.status}): invalid API key` } }
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
  const baseResp = b.base_resp
  if (baseResp && typeof baseResp === 'object') {
    const code = num((baseResp as Record<string, unknown>).status_code) ?? -1
    if (code !== 0) {
      const msg = (baseResp as Record<string, unknown>).status_msg ?? 'Unknown error'
      return { data: null, error: { kind: 'soft', message: `API error (code ${code}): ${String(msg)}` } }
    }
  }

  const tiers = parseMinimaxTiers(body)
  if (tiers.length === 0) {
    return { data: null, error: { kind: 'soft', message: 'Response did not contain a usable general-plan quota' } }
  }
  return { data: { planKind: 'subscription', planType: null, tiers }, error: null }
}

export const minimaxAdapter: PlatformAdapter = {
  id: 'minimax',
  label: 'MiniMax',
  isConfigured: (cfg) => Boolean(cfg.minimaxApiKey),
  query: (http, cfg) => queryMinimax(http, cfg.minimaxApiKey, cfg.minimaxRegion),
}