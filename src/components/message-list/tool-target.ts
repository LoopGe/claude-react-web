// What a tool call is *about*, as a short label for the folded group header.
//
// `Read · Grep · Edit` tells you which kinds of work happened; it does not
// tell you whether the run touched the file you care about. This module turns
// a tool_use input into the missing half — `App.tsx`, `"useWsHub"`,
// `npm run typecheck` — inside a budget tight enough that several of them
// still fit on one line.
//
// Which input field counts as the target is NOT decided here: `pickToolArg`
// owns that ladder so this and SubagentCard's child rows can't drift on it.
// Everything below is only about shortening and per-tool flavour.

import { pickToolArg } from '../../session-store/normalize'
import { splitFilePath } from '../../utils/file-display'
import { truncate } from '../../utils/text'

/** Tools whose target is a search expression rather than a thing, quoted the
 *  way their own cards quote it (GrepToolView / WebSearchToolView use this
 *  same pair of typographic quotes). Glob is deliberately absent — its card
 *  shows the pattern bare. */
const QUOTED_TARGET_TOOLS = new Set(['Grep', 'WebSearch'])

/** Per-target cap. Deliberately much tighter than the 80 chars a subagent
 *  child row gets: several targets share ONE line here, so a long Bash
 *  command must not spend the whole budget. */
const TARGET_MAX = 28

/** Short target label for one tool call, or '' when the tool has nothing
 *  useful to point at (TodoWrite, EnterPlanMode, empty input, …).
 *
 *  Paths collapse to their basename. The last-two-segments form used by
 *  subagent rows is better when a row shows one path and nothing else, but
 *  here the directory is what gets eaten by the shared ellipsis first, and
 *  `useWsHub.ts` identifies the file well enough next to a tool name. */
export function toolTargetLabel(name: string | undefined, input: unknown): string {
  const arg = pickToolArg(input)
  if (!arg) return ''
  const raw = arg.kind === 'path' ? splitFilePath(arg.value).base || arg.value : arg.value
  if (!raw) return ''
  const clipped = truncate(raw, TARGET_MAX)
  return name && QUOTED_TARGET_TOOLS.has(name) ? `\u201c${clipped}\u201d` : clipped
}
