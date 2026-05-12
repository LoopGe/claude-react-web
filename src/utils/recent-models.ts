/** Load the recent-models list that the New Session dialog maintains.
 *  Read-only from the ChatPanel side; we just want autocomplete hints
 *  for the inline model editor. Returns an empty array on any failure. */
export function readRecentModels(): string[] {
  try {
    const raw = window.localStorage.getItem('claude-react-web:recent-models')
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as string[]).filter((s) => typeof s === 'string') : []
  } catch {
    return []
  }
}
