// Shared launch helper for the open-path actions (project popover buttons,
// session context-menu "Open in …" items). Owns the per-consumer in-flight
// guard — a double-click or a menu double-activation must not spawn the
// target app twice — and normalizes refusals/transport failures into a plain
// outcome, so each surface picks its own presentation (inline error row vs
// toast) without duplicating the request logic.

import { useRef, useState } from 'react'
import { api } from './useApi'
import { isOpenPathTarget, type OpenPathTarget } from '../../shared/open-path'

export interface OpenPathOutcome {
  ok: boolean
  /** Present when !ok: the server's refusal text or the transport error. */
  message?: string
}

function errorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) return String((err as { message: unknown }).message)
  return String(err)
}

/**
 * Launch one target on one absolute directory, on the SERVER machine.
 * Concurrent calls while a launch is pending are refused (no second POST).
 * Never rejects — failures come back as `{ ok: false, message }`.
 */
export function useOpenPath(): {
  open: (target: OpenPathTarget, path: string) => Promise<OpenPathOutcome>
  /** The target of the in-flight launch, or null when idle. */
  pending: OpenPathTarget | null
} {
  const [pending, setPending] = useState<OpenPathTarget | null>(null)
  // Synchronous guard: `pending` (render state) lags one commit behind, so
  // two open() calls in the same tick would both read the stale value and
  // both POST. The ref is the authority; the state only drives the UI.
  const busyRef = useRef(false)
  const open = async (target: OpenPathTarget, path: string): Promise<OpenPathOutcome> => {
    if (busyRef.current) return { ok: false, message: 'Another open action is in progress' }
    if (!isOpenPathTarget(target)) return { ok: false, message: `unknown target: ${String(target)}` }
    busyRef.current = true
    setPending(target)
    try {
      await api.post('/open-path', { path, target })
      return { ok: true }
    } catch (err) {
      return { ok: false, message: errorMessage(err) }
    } finally {
      busyRef.current = false
      setPending(null)
    }
  }
  return { open, pending }
}
