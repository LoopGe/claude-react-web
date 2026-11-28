// server/providers/native/tools/hook-port.ts
//
// The narrow hook seam a TOOL needs when the CLI fires the hook from inside the
// tool implementation rather than from the generic tool loop (TaskCreated /
// TaskCompleted / WorktreeCreate / WorktreeRemove). The session owns the
// dispatch (session_id, cwd, transcript_path stamping) and the tool only names
// the event + the event-specific fields.
import type { HookDecision, HookEvent } from '../../../../shared/hooks.js'

export interface ToolHookPort {
  /** Whether any configured source contributes a hook for the event. Used by
   *  WorktreeCreate: a configured creator hook REPLACES normal creation, so
   *  the tool must not fall back to `git worktree` when it returns no path. */
  configured(event: HookEvent): boolean
  dispatch(event: HookEvent, fields: Record<string, unknown>, signal: AbortSignal): Promise<HookDecision>
}
