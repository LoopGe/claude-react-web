/** Format a token count for display: 1234 → "1.2k", 15000 → "15k". */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}
