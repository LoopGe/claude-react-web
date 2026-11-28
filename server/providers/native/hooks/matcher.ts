// server/providers/native/hooks/matcher.ts
import { createLogger } from '../../../log.js'
import type { HookEvent } from './types.js'

const log = createLogger('native-hooks')

/** Literal-list charset (RS §4.1; the CLI's `tEn` gate): a matcher composed
 *  only of these characters is a name list, not a regular expression. */
const LITERAL_LIST = /^[a-zA-Z0-9_|, -]+$/

/** Evaluate one hook matcher against an event's matcher target (RS §4.1).
 *  Empty / `*` / `.*` match everything. A literal-list matcher splits on `|`
 *  or `,`, trims each name and requires EXACT equality (no prefix/substring).
 *  Anything else is an unanchored, case-sensitive regex. An invalid regex
 *  logs and matches nothing — it never throws. A missing target means the
 *  event has no matcher target (see matcherTarget), so the matcher is
 *  ignored and everything matches. */
export function matches(matcher: string | undefined, target: string | undefined): boolean {
  if (!matcher || matcher === '*' || matcher === '.*') return true
  if (target === undefined) return true
  if (LITERAL_LIST.test(matcher)) {
    return matcher.split(/[|,]/).map((name) => name.trim()).filter(Boolean).some((name) => name === target)
  }
  try {
    return new RegExp(matcher).test(target)
  } catch {
    log.warn(`Invalid regex pattern in hook matcher: ${JSON.stringify(matcher)}`)
    return false
  }
}

/** Read one input field as the matcher target: only a string value is a
 *  target; a missing or non-string field yields none. */
function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' ? value : undefined
}

/** The event's matcher target (RS §3 `qZe` map): the five tool events match
 *  on tool_name, SessionStart on source, Pre/PostCompact on trigger,
 *  SubagentStart/Stop on agent_type, StopFailure on error, Notification on
 *  notification_type, InstructionsLoaded on load_reason. Every other event
 *  (Stop, UserPromptSubmit, …) has no target — undefined — and its hooks'
 *  matchers are ignored. */
export function matcherTarget(event: HookEvent, input: Record<string, unknown>): string | undefined {
  switch (event) {
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionRequest':
    case 'PermissionDenied':
      return stringField(input, 'tool_name')
    case 'SessionStart':
      return stringField(input, 'source')
    case 'PreCompact':
    case 'PostCompact':
      return stringField(input, 'trigger')
    case 'SubagentStart':
    case 'SubagentStop':
      return stringField(input, 'agent_type')
    case 'StopFailure':
      return stringField(input, 'error')
    case 'Notification':
      return stringField(input, 'notification_type')
    case 'InstructionsLoaded':
      return stringField(input, 'load_reason')
    default:
      return undefined
  }
}
