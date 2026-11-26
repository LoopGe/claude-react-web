// server/providers/native/hooks/collection.ts
import type { HookConfig, HookEvent, HookMatcherConfig } from '../../../../shared/hooks.js'
import type { HookSource } from './types.js'

/** Identity of one hook within an event's collected list (RS §7 `a2`):
 *  matcher + hook type + the type's defining field (command / url / prompt).
 *  Other fields (timeout, shell, headers, model, if, …) do NOT distinguish
 *  hooks — a later duplicate is dropped wholesale and the earlier copy, with
 *  all its fields, wins. Absent and empty matcher normalize to one identity
 *  (both mean match-all). The tuple is JSON-encoded so no field value can
 *  forge a separator collision. */
function hookIdentity(matcher: string | undefined, hook: HookConfig): string {
  const defining = hook.type === 'command' ? hook.command : hook.type === 'http' ? hook.url : hook.prompt
  return JSON.stringify([matcher ?? '', hook.type, defining])
}

/** Collect one event's matcher groups from every source, concatenated in array
 *  order (the caller passes CLI precedence flag → settings → plugin → agent),
 *  dropping hooks an earlier source already contributed (RS §7 `a2`). Group
 *  boundaries stay as concatenated — no regrouping; a group whose hooks were
 *  all deduped away is dropped. No sources (or nothing on the event) → []. */
export function collectForEvent(sources: readonly HookSource[], event: HookEvent): HookMatcherConfig[] {
  const seen = new Set<string>()
  const out: HookMatcherConfig[] = []
  for (const source of sources) {
    for (const matcher of source.collect(event)) {
      const hooks = matcher.hooks.filter((hook) => {
        const key = hookIdentity(matcher.matcher, hook)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (hooks.length > 0) out.push({ ...matcher, hooks })
    }
  }
  return out
}