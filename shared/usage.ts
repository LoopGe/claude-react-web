/**
 * Loose, browser-safe shapes for the SDK's structured /usage data
 * (`Query.usage_EXPERIMENTAL_...()` — the data behind the CLI `/usage`
 * command). The SDK response type is EXPERIMENTAL and will be renamed /
 * reshaped when stabilized, so every field here is optional and all client
 * rendering must be defensive (`typeof` checks, ignore unknown fields).
 */

/** One claude.ai plan rate-limit window. */
export interface UsageRateLimitWindow {
  /** 0–100, or null when the backend can't compute it yet. */
  utilization?: number | null
  /** ISO timestamp, or null when unknown. */
  resets_at?: string | null
}

/** `rate_limits.extra_usage` — purchased extra-usage credits. */
export interface UsageExtraUsage {
  is_enabled?: boolean
  monthly_limit?: number
  used_credits?: number
  utilization?: number | null
  currency?: string
}

export interface UsageRateLimits {
  five_hour?: UsageRateLimitWindow | null
  seven_day?: UsageRateLimitWindow | null
  seven_day_oauth_apps?: UsageRateLimitWindow | null
  seven_day_opus?: UsageRateLimitWindow | null
  seven_day_sonnet?: UsageRateLimitWindow | null
  extra_usage?: UsageExtraUsage | null
}

/** Per-model token/cost breakdown for the session. */
export interface UsageModelEntry {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  webSearchRequests?: number
  costUSD?: number
  contextWindow?: number
  maxOutputTokens?: number
}

export interface UsageSessionTotals {
  total_cost_usd?: number
  total_api_duration_ms?: number
  total_duration_ms?: number
  total_lines_added?: number
  total_lines_removed?: number
  model_usage?: Record<string, UsageModelEntry>
}

export interface SessionUsageData {
  session?: UsageSessionTotals
  subscription_type?: 'pro' | 'max' | 'team' | 'enterprise' | null
  rate_limits_available?: boolean
  rate_limits?: UsageRateLimits | null
  behaviors?: Record<string, unknown>
}

/** Display labels for the plan rate-limit windows (keyed by SDK field name). */
export const USAGE_WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: '7-day limit',
  seven_day_oauth_apps: 'OAuth apps 7-day',
  seven_day_opus: 'Opus 7-day',
  seven_day_sonnet: 'Sonnet 7-day',
}

/** Ordered window keys actually rendered in the UsagePanel. */
export const USAGE_WINDOW_KEYS = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_oauth_apps',
] as const

export type UsageWindowKey = (typeof USAGE_WINDOW_KEYS)[number]
