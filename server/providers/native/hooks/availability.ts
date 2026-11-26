// server/providers/native/hooks/availability.ts
import type { HookEvent } from './types.js'

/** The events the CLI dispatches through the non-REPL runner (`lN` /
 *  executeHooksOutsideREPL, RS §12.2). prompt/agent hooks on these fail with
 *  "not yet supported outside REPL" — a STRUCTURAL gate independent of whether
 *  conversation context happens to be available. */
const NON_REPL_EVENTS = new Set<HookEvent>([
  'SessionEnd',
  'StopFailure',
  'PreCompact',
  'PostCompact',
  'ConfigChange',
  'Notification',
  'Elicitation',
  'ElicitationResult',
  'CwdChanged',
  'FileChanged',
  'InstructionsLoaded',
  'WorktreeCreate',
  'WorktreeRemove',
])

/** A prompt/agent hook's availability for one event. `ok:false` is a
 *  NON-BLOCKING error result (RS §12.2: the CLI catches the gate throw and
 *  reports non_blocking_error — prompt/agent do not honor onFailure:'block'),
 *  never a throw and never silent success. The caller surfaces `reason` as the
 *  hook-run error and lets the guarded action proceed. */
export type AvailabilityResult = { ok: true } | { ok: false; reason: string }

/** Gate a prompt/agent hook against the REAL per-event availability matrix
 *  (RS §12.2), NOT the stale "tool events only" help text. Three checks, in
 *  the CLI's order:
 *
 *  1. agent on PermissionRequest is EXPLICITLY rejected — an agent hook answers
 *     ok/not-ok and cannot return the allow/deny decision a permission request
 *     needs (prompt IS allowed there).
 *  2. non-REPL events (PreCompact/PostCompact/StopFailure/SessionEnd/…) fail
 *     regardless of context.
 *  3. any remaining event dispatched WITHOUT conversation context
 *     (SessionStart/SubagentStart/Setup, or a seam passing `hasContext:false`)
 *     fails the `if(!toolUseContext)` gate.
 *
 *  `hasContext` is the caller's report of whether the dispatch seam holds a
 *  conversation context (the CLI's `toolUseContext` / `w`); Stop/SubagentStop/
 *  UserPromptSubmit and the tool events WITH context pass. Reason strings
 *  mirror the CLI wording. Neutral: imports only the sibling HookEvent type. */
export function checkAvailability(
  type: 'prompt' | 'agent',
  event: HookEvent,
  hasContext: boolean,
): AvailabilityResult {
  if (type === 'agent' && event === 'PermissionRequest') {
    return {
      ok: false,
      reason:
        'agent-type hooks are not supported for PermissionRequest events (an agent hook answers ok or not ok, and cannot return the allow / deny decision a permission request needs). Use a command- or http-type hook instead.',
    }
  }
  if (NON_REPL_EVENTS.has(event)) {
    return {
      ok: false,
      reason:
        type === 'prompt'
          ? 'Prompt stop hooks are not yet supported outside REPL'
          : 'Agent stop hooks are not yet supported outside REPL',
    }
  }
  if (!hasContext) {
    return {
      ok: false,
      reason: `${type}-type hooks are not supported for ${event} events (no conversation context is available). Use a command-type hook instead.`,
    }
  }
  return { ok: true }
}
