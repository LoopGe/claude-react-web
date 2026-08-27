// Data contract for the 'stat-grid' widget kind. A stat-grid widget is a
// compact list of labeled values with optional progress bars. The plugin
// pushes JSON payloads of this shape over the `app.event` RPC notification;
// the host renders them with theme tokens. The plugin never ships DOM.

export type WidgetTone = 'ok' | 'warn' | 'danger'

export interface StatRow {
  id: string
  label: string
  value: string       // pre-formatted display text, e.g. '23.4'
  unit?: string       // '%' | 'GB' | ...
  progress?: number   // 0..1, drives the progress bar
  tone?: WidgetTone
}

export interface StatGridPayload {
  values: StatRow[]
}

const TONES: ReadonlySet<string> = new Set(['ok', 'warn', 'danger'])

/** Validate + normalize an unknown payload into a StatGridPayload, or null.
 *  Invalid rows are dropped; a payload with zero valid rows is rejected. */
export function parseStatGridPayload(p: unknown): StatGridPayload | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  const values = (p as { values?: unknown }).values
  if (!Array.isArray(values)) return null
  const rows: StatRow[] = []
  for (const raw of values) {
    const row = parseStatRow(raw)
    if (row) rows.push(row)
  }
  if (rows.length === 0) return null
  return { values: rows }
}

function parseStatRow(raw: unknown): StatRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0) return null
  if (typeof r.label !== 'string' || r.label.length === 0) return null
  if (typeof r.value !== 'string' || r.value.length === 0) return null
  let unit: string | undefined
  if (r.unit !== undefined) {
    if (typeof r.unit !== 'string') return null
    unit = r.unit
  }
  let progress: number | undefined
  if (r.progress !== undefined) {
    if (typeof r.progress !== 'number' || !Number.isFinite(r.progress)) return null
    if (r.progress < 0 || r.progress > 1) return null
    progress = r.progress
  }
  let tone: WidgetTone | undefined
  if (r.tone !== undefined) {
    if (typeof r.tone !== 'string' || !TONES.has(r.tone)) return null
    tone = r.tone as WidgetTone
  }
  return { id: r.id, label: r.label, value: r.value, unit, progress, tone }
}
