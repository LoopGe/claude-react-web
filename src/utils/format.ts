/** Format a token count for display: 1234 → "1.2k", 15000 → "15k". */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

/** Format elapsed milliseconds as a compact duration string: "45s", "02:30", "1:02:30". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  if (h === 0) return `${pad(m)}:${pad(sec)}`
  return `${h}:${pad(m)}:${pad(sec)}`
}

/** Pretty-print a value as indented JSON, falling back to String(). */
export function formatJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** Format a byte count as a human-readable string: "512 B", "1.5 MB", "2.0 GB". */
export function formatBytes(n: number): string {
  if (n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

/** Format an ISO timestamp as a compact relative-time string:
 *  "just now", "5m ago", "3h ago", "yesterday", "5d ago", "3w ago",
 *  or a localized date for anything older than a month. Falsy /
 *  un-parseable inputs return an empty string so callers can render
 *  conditionally without an extra null check. Future timestamps are
 *  treated as "just now" rather than emitting a misleading negative
 *  duration. */
export function formatRelativeTime(iso: string | undefined | null, now: number = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const deltaMs = now - t
  if (deltaMs < 0) return 'just now'
  const sec = Math.floor(deltaMs / 1000)
  // Threshold has to land on a minute boundary, otherwise the
  // [threshold, 60s) range produces "0m ago" — `Math.floor(sec / 60)`
  // is 0 in that interval. "just now" therefore covers the full first
  // minute; minutes-ago kicks in at exactly 60s.
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day === 1) return 'yesterday'
  if (day < 7) return `${day}d ago`
  const week = Math.floor(day / 7)
  if (week < 5) return `${week}w ago`
  // Older than ~5 weeks — fall back to an absolute date. Local date
  // string is OK here; relative-time becomes vague past a month.
  try {
    return new Date(t).toLocaleDateString()
  } catch {
    return ''
  }
}
