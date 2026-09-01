// Normalized per-platform quota snapshot + keep-last-good decision logic.
//
// keep-last-good is ported from cc-switch's src/lib/query/queries.ts
// (resolveDisplayUsage). Strategy: a TRANSIENT failure (network error,
// HTTP 5xx, 429) keeps showing the last successful value for a short window
// so a single hiccup doesn't blank the widget; a DETERMINISTIC failure
// (auth, empty credentials, 4xx) surfaces immediately and DROPS the old
// snapshot so a stale quota is never resurrected after the credentials
// actually broke.

import type { PlatformQueryData } from './platform.js'

export const KEEP_LAST_GOOD_MS = 10 * 60 * 1000

export type CredentialStatus = 'valid' | 'expired' | 'error'

export interface QuotaSnapshot extends PlatformQueryData {
  platformId: string
  platformLabel: string
  credentialStatus: CredentialStatus
  /** Human-readable failure message (when success is false). */
  error: string | null
  queriedAt: number
  success: boolean
}

export function authErrorSnapshot(platformId: string, platformLabel: string, message: string): QuotaSnapshot {
  return {
    platformId,
    platformLabel,
    planKind: null,
    planType: null,
    tiers: [],
    balance: null,
    credentialStatus: 'expired',
    error: message,
    queriedAt: Date.now(),
    success: false,
  }
}

/** Failure classification — mirrors cc-switch's isTransientUsageError whitelist.
 *  Unknown errors are treated as deterministic (fail-safe). */
export function isTransientError(message: string): boolean {
  const e = message.toLowerCase()
  if (!e) return false
  if (e.includes('network error') || e.includes('timed out') || e.includes('request failed')) {
    return true
  }
  const httpMatch = e.match(/http\s+(\d{3})/)
  if (httpMatch) {
    const status = Number(httpMatch[1])
    return (status >= 500 && status <= 599) || status === 429
  }
  return false
}

export interface LastGoodSnapshot {
  data: QuotaSnapshot
  at: number
}

/** Keep-last-good decision. Returns the value to display and the updated
 *  last-good snapshot (null to clear it). Pure — `now` injected for tests. */
export function resolveDisplay(
  raw: QuotaSnapshot,
  prevLastGood: LastGoodSnapshot | null,
  now: number,
): { data: QuotaSnapshot; lastGood: LastGoodSnapshot | null } {
  let lastGood = prevLastGood
  if (raw.success) {
    lastGood = { data: raw, at: now }
  } else if (raw.error && !isTransientError(raw.error)) {
    // Deterministic failure — old snapshot is no longer trustworthy.
    lastGood = null
  }

  let data = raw
  if (
    !raw.success &&
    raw.error &&
    isTransientError(raw.error) &&
    lastGood &&
    now - lastGood.at < KEEP_LAST_GOOD_MS
  ) {
    data = lastGood.data
  }
  return { data, lastGood }
}

/** Color thresholds for the widget (mirror cc-switch's tone mapping). */
export function toneForUtilization(u: number): 'ok' | 'warn' | 'danger' {
  if (u >= 90) return 'danger'
  if (u >= 70) return 'warn'
  return 'ok'
}

/** The earliest FUTURE quota-window reset across the given tiers, or null
 *  when no window reports a usable reset in the future. Pure — `now`
 *  injected so stale (already-passed) resets are ignored. */
export function nextResetAt(tiers: Array<{ resets_at: string | null }>, now: number): number | null {
  let earliest: number | null = null
  for (const t of tiers) {
    if (!t.resets_at) continue
    const ms = Date.parse(t.resets_at)
    if (Number.isNaN(ms) || ms <= now) continue
    if (earliest === null || ms < earliest) earliest = ms
  }
  return earliest
}