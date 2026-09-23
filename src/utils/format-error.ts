/** Normalize an unknown catch-clause value into a display string.
 *  The single home for the `err instanceof Error ? err.message : String(err)`
 *  idiom that was previously inlined at ~25 call sites. */
export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
