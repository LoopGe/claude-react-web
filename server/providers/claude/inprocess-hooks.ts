import { randomUUID } from 'node:crypto'
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import type { HookEvent, HookRuntimeEvent } from '../../../shared/hooks.js'

/** Called by an in-process read+react callback to surface structured input
 *  into the existing hook run-log channel. Fire-and-forget; never blocks. */
export type InProcessHookForward = (sessionId: string, event: HookRuntimeEvent) => void

const DEFAULT_CAP = 4096

/** Truncate a serialized input, keeping the head and appending a marker. */
export function capHookInput(s: string, max: number = DEFAULT_CAP): string {
  if (s.length <= max) return s
  const keep = Math.max(0, max - 20)
  return `${s.slice(0, keep)}…[truncated ${s.length - keep} chars]`.slice(0, max)
}

/** Wrap a callback so a throw/slow inner never crashes the host query() process. */
function defensiveHook(fn: (input: unknown) => void): (input: unknown, toolUseID: string | undefined, deps?: { signal?: AbortSignal }) => Promise<unknown> {
  return async (input: unknown, _toolUseID?: string, deps?: { signal?: AbortSignal }): Promise<unknown> => {
    if (deps?.signal?.aborted) return undefined
    try {
      fn(input)
    } catch {
      // In-process hook observed input; a malformed/throwy input must not crash the pump.
    }
    return undefined
  }
}

function buildStop(forward?: InProcessHookForward): (input: unknown) => void {
  return (input) => {
    const obj = (input ?? {}) as { session_id?: unknown; transcript_path?: unknown; reason?: unknown }
    if (typeof obj.session_id !== 'string' || !forward) return
    const detail: Record<string, unknown> = {}
    if (typeof obj.transcript_path === 'string') detail.transcript_path = obj.transcript_path
    if (typeof obj.reason === 'string') detail.reason = obj.reason
    const id = randomUUID()
    const run = {
      id,
      hookId: id,
      hookName: 'inproc:Stop',
      event: 'Stop',
      status: 'success' as const,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      ...(Object.keys(detail).length > 0 ? { hookInput: capHookInput(JSON.stringify(detail)) } : {}),
    }
    forward(obj.session_id, { kind: 'completed', run })
  }
}

/** Build the in-process read+react hooks object the provider injects into
 *  `Options.hooks`. Only the `Stop` event carries a `transcript_path` in this
 *  SDK/CLI/Ark stack (probe-verified); SessionEnd/Notification do not fire.
 *  Tool governance is intentionally absent (probe-disproven). */
export function buildInProcessHooks(forward?: InProcessHookForward): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    Stop: [{ hooks: [defensiveHook(buildStop(forward))] }],
  } as Partial<Record<HookEvent, HookCallbackMatcher[]>>
}