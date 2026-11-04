/** Serialize `data` as JSON and trigger a browser download. Pretty by
 *  default; `pretty: false` keeps large diagnostic payloads (traces) cheap to
 *  stringify on the main thread. */
export function downloadJson(filename: string, data: unknown, opts: { pretty?: boolean } = {}): void {
  const json = opts.pretty === false ? JSON.stringify(data) : JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
