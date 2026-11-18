// truncate / stripAnsi moved to shared/text.ts so the server search index and
// the client renderer share one ANSI-aware truncation. Re-exported here so every
// existing import site keeps compiling.
export { truncate, stripAnsi } from '../../shared/text'

/** Extract a plugin namespace tag from the start of a command/agent
 *  description. The SDK doesn't namespace plugin command NAMES (they're bare,
 *  e.g. "docx"); instead it prefixes the DESCRIPTION with a parenthesised
 *  plugin tag, e.g. "(skills) Use this skill…" or "(atlassian) Analyze…".
 *  Returns the inner tag text, or null when the description has no leading
 *  "(tag) " marker. The required leading "(" + closing ")" means trailing
 *  notes like "… (dynamic workflow)" are NOT matched. */
export function pluginTagOf(description: string | undefined): string | null {
  if (!description) return null
  const m = /^\(([^)]+)\)/.exec(description)
  return m ? m[1].trim() : null
}