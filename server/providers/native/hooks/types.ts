// server/providers/native/hooks/types.ts
import type { HookEvent, HookMatcherConfig } from '../../../../shared/hooks.js'

// The shared config vocabulary the engine consumes, re-exported so the hook
// modules have one import surface (shared/hooks.ts stays the single definition).
export type { HookEvent, HookMatcherConfig, SessionHooksConfig } from '../../../../shared/hooks.js'

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

/** Engine-internal MULTI-FACT hook decision (controller ruling after the T6
 *  review). The CLI's `hookSpecificOutput` carries SIMULTANEOUS facts — a hook
 *  can allow AND add context, rewrite output AND assert classifier context — so
 *  a single-variant union would discard honored facts. The merged decision
 *  carries a primary `action` PLUS all side facts. The engine validates each
 *  hook's `hookSpecificOutput.hookEventName === event` and gates per-event field
 *  applicability; the per-event ACTION semantics (does exit-2 block this event,
 *  deny-vs-erase-vs-continue, rewrite application) live in the dispatch seams.
 *  Field names follow RS §3 per-event hookSpecificOutput. Neutral: no SDK types
 *  (`updatedPermissions` is a loose passthrough the host seam projects). */
export interface HookDecision {
  /** Primary action, rank-merged across hooks: block > deny > allow > ask >
   *  defer > continue. */
  action: 'continue' | 'block' | 'allow' | 'deny' | 'ask' | 'defer'
  /** Present when action === 'block': the effective block message + its RS §3
   *  audience (model vs user). */
  block?: { reason: string; target: 'model' | 'user' }
  /** The dominant permission decision (PreToolUse permissionDecision /
   *  PermissionRequest decision). Absent when action is continue/block. */
  permission?: {
    behavior: 'allow' | 'deny' | 'ask' | 'defer'
    updatedInput?: Record<string, unknown>
    reason?: string
    message?: string
    interrupt?: boolean
    /** Neutral passthrough; the host seam projects to SDK PermissionUpdate[]. */
    updatedPermissions?: unknown[]
  }
  /** ALWAYS accumulated across hooks, never dropped when an action dominates. */
  additionalContext: string[]
  /** PostToolUse rewrites — last-write-wins in collection order (RS §4.9). */
  updatedToolOutput?: string
  updatedMCPToolOutput?: string
  classifierContext?: string
  /** Stop forced-continuation; continue:false overrides exit-2 (RS §2.3) — the
   *  seam applies that override, the engine carries the fact. */
  continue?: boolean
  stopReason?: string
  suppressOutput?: boolean
  systemMessage?: string
  /** UserPromptSubmit / SessionStart. */
  suppressOriginalPrompt?: boolean
  sessionTitle?: string
  /** SessionStart. */
  initialUserMessage?: string
  watchPaths?: string[]
  reloadSkills?: boolean
  /** PermissionDenied. */
  retry?: boolean
  /** PreCompact exit-0 plain stdout (custom compact instructions, RS §13.3). */
  customInstructions?: string
}
