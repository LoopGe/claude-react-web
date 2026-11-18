/** Pretty-print a value as indented JSON, falling back to String(). */
export function formatJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}