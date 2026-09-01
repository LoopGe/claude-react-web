// Shared types + helpers for the quota platform adapters.
//
// Each platform adapter exposes a `query(http, cfg)` that normalizes the
// platform's quota response into `PlatformQueryData` (a list of utilization
// windows) and classifies failures into auth / soft / transient. The service
// layer merges all adapters into one widget + one command output.

export const TIER_FIVE_HOUR = 'five_hour'
export const TIER_WEEKLY = 'weekly'
export const TIER_MONTHLY = 'monthly'
export const TIER_DAILY = 'daily'

/** One quota window. utilization is 0–100. */
export interface QuotaTier {
  name: string
  label: string
  utilization: number
  resets_at: string | null
  /** Absolute values when the API reports them (e.g. Volcengine AFP). */
  used?: number
  quota?: number
}

export interface PlatformQueryData {
  planKind: 'agent' | 'coding' | 'subscription' | null
  planType: string | null
  tiers: QuotaTier[]
  /** Scalar account balance (generic relay adapters). */
  balance?: { amount: number; currency?: string } | null
}

/** Failure classification used by the keep-last-good logic. */
export type FailureKind = 'auth' | 'soft' | 'transient'

export interface PlatformQueryResult {
  data: PlatformQueryData | null
  error: { kind: FailureKind; message: string } | null
}

/** Minimal HTTP client shape — implemented by the broker-backed callHost
 *  adapter and the direct-fetch adapter for the generic platform. */
export interface HttpResult {
  status: number
  headers: Record<string, string>
  body: string
}

export interface HttpRequestOptions {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export interface HttpClient {
  request(opts: HttpRequestOptions): Promise<HttpResult>
}

/** Full plugin configuration (merged defaults + user values, already
 *  validated by the service layer). Empty credential fields mean that
 *  platform is inactive. */
export interface PluginConfig {
  refreshMinutes: number
  volcBaseUrl: string
  volcAccessKeyId: string
  volcSecretAccessKey: string
  zhipuBaseUrl: string
  zhipuApiKey: string
  kimiApiKey: string
  minimaxApiKey: string
  minimaxRegion: 'cn' | 'intl'
  zenmuxUrl: string
  zenmuxApiKey: string
  opencodeGoApiKey: string
  genericName: string
  genericUrl: string
  genericMethod: 'GET' | 'POST'
  genericBearerToken: string
  /** Widget window filter: fiveHour / weekly / monthly / daily. */
  showWindows: string[]
}

export interface PlatformAdapter {
  id: string
  /** Short tag shown in the widget rows (e.g. 'Ark'). */
  label: string
  isConfigured(cfg: PluginConfig): boolean
  query(http: HttpClient, cfg: PluginConfig): Promise<PlatformQueryResult>
}

// ── JSON helpers ──────────────────────────────────────────────────────

/** Parse a number field defensively (number | numeric string). */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

/** Convert an epoch value (sec or ms, number or string) to ISO 8601, or null. */
export function epochToIso(v: unknown): string | null {
  const n = num(v)
  if (n === undefined) return null
  const ms = n < 1e12 ? n * 1000 : n
  if (!Number.isFinite(ms) || ms <= 0) return null
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

/** Parse a reset time that may be either an ISO string (ZenMux / OpenCode Go)
 *  or an epoch number/string (Volcengine / Zhipu / Kimi). */
export function parseResetTime(v: unknown): string | null {
  if (typeof v === 'string' && !/^\d+$/.test(v)) {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
    return null
  }
  return epochToIso(v)
}

export const WINDOW_LABELS: Record<string, string> = {
  [TIER_FIVE_HOUR]: '5-hour',
  [TIER_WEEKLY]: 'Weekly',
  [TIER_MONTHLY]: 'Monthly',
  [TIER_DAILY]: 'Daily',
}