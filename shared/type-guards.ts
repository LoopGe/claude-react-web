/** Runtime shape guards shared by server and client. Single home for the
 *  previously-duplicated isPlainObject / isStringArray definitions that
 *  lived (identically) in hooks.ts, sandbox.ts and tool-profile.ts. */

/** Any non-null, non-array object — plain records parsed from JSON,
 *  options bags, arbitrary payloads. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An array whose every element is a string. */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === 'string')
}
