/** Join class-name parts, skipping falsy ones.
 *  The single home for the `[...].filter(Boolean).join(' ')` idiom that was
 *  previously inlined across ~15 call sites. Accepts nested arrays so
 *  conditional groups can stay inline: `cx('base', active && 'on', ['a', wide && 'b'])`. */
export type CxPart = string | false | null | undefined | CxPart[]

export function cx(...parts: CxPart[]): string {
  const out: string[] = []
  for (const p of parts) {
    if (Array.isArray(p)) {
      const nested = cx(...p)
      if (nested) out.push(nested)
    } else if (p) {
      out.push(p)
    }
  }
  return out.join(' ')
}
