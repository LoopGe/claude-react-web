// server/providers/native/hooks/types.ts
import type { HookEvent, HookMatcherConfig } from '../../../../shared/hooks.js'

// The shared config vocabulary the engine consumes, re-exported so the hook
// modules have one import surface (shared/hooks.ts stays the single definition).
export type { HookEvent, HookMatcherConfig, SessionHooksConfig, HookDecision } from '../../../../shared/hooks.js'

/** One ordered hook-config source. The caller passes sources to collectForEvent
 *  in CLI precedence order (flag → settings → plugin → agent); only `flag` is
 *  wired by the first project, the other kinds arrive with their config seams. */
export interface HookSource {
  readonly kind: 'flag' | 'settings' | 'plugin' | 'agent'
  /** Matcher groups this source contributes for the event, in source order.
   *  Re-collected per dispatch, so a live config change takes effect on the
   *  next event without rebuilding the source list. */
  collect(event: HookEvent): HookMatcherConfig[]
}
