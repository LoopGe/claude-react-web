export function fmtJson(data: unknown): string {
  return JSON.stringify(data, null, 2)
}

export function maskToken(token: string | undefined): string | undefined {
  return token ? '****' + token.slice(-4) : undefined
}

export function table(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows]
  if (all.length === 0) return ''
  const widths = headers.map((_, ci) => Math.max(...all.map((r) => (r[ci] ?? '').length)))
  const fmtRow = (r: string[]) => r.map((c, ci) => String(c ?? '').padEnd(widths[ci])).join('  ').trimEnd()
  return [fmtRow(headers), ...rows.map(fmtRow)].join('\n')
}
