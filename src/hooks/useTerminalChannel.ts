// Per-session terminal channel over the WS hub — the data layer of the
// terminal overlay (TerminalOverlay/TerminalBody own the rendering).
//
// Render isolation (the streaming rule): live output churn touches ONLY refs
// and the leaf-level subscribeOutput listener set — never React state — so
// the hook's host does not re-render per chunk. State/snapshot transitions
// (spawn / exit / close / attach seed / resync answer) are the only renders.
//
// Generation + seq model (server contract, server/terminal.ts):
// - `terminalId` is a fresh uuid per spawn; output `seq` is monotonic per
//   generation. The snapshot is the screen anchor: its `seq` counts every
//   chunk already parsed into `screen`.
// - The create answer's snapshot is seq 1 AND the restore divider ALSO fans
//   out as output seq 1 — output at or below the anchored seq is deduped, or
//   the divider would render twice.
// - A seq gap (the server's drop-oldest subscriber queue let a slow viewer
//   fall behind) is recovered by ONE terminal-resync; the fresh snapshot
//   re-anchors screen + seq. No raw-output replay exists.
// - The snapshot seed can theoretically be absent (manager null) — the first
//   terminal frame of ANY kind anchors the channel; nothing waits on a
//   snapshot that may never come.
// - A frame revealing a generation we have no screen for (another tab spawned
//   while we sat idle/exited) requests the anchor via resync too: the create
//   snapshot answer goes to the creator only, so re-anchoring is the only way
//   a bystander tab sees the new screen (incl. the restore divider).
//
// Association memory: localStorage `crw.terminal.binding.<sessionId>` holds
// the terminalId last seen running. A remembered tab meeting a restored-idle
// snapshot (server restart killed the shell, screen persisted) auto-sends
// terminal-create ONCE per snapshot; a fresh tab with no binding sees the
// history and creates manually. Close — local or server-confirmed idle —
// clears the binding.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalSnapshot, TerminalState } from '../../shared/terminal.js'
import type { WsServerFrame } from '../ws-types'
import { terminalBindingKey } from '../constants/storageKeys'
import { useWsHub } from './useWsHub'

export interface TerminalChannel {
  /** From SessionInfo.terminalSupported — false renders the unavailable panel. */
  supported: boolean
  /** Current lifecycle state; re-renders the host ONLY on transitions. */
  state: TerminalState | null
  /** Latest attach/resync seed (screen + generation + seq it reflects). */
  snapshot: TerminalSnapshot | null
  /** Leaf-level live-output subscription — zero host re-renders per chunk. */
  subscribeOutput(cb: (data: string) => void): () => void
  create(cols: number, rows: number): void
  input(data: string): void
  resize(cols: number, rows: number): void
  close(): void
}

/** Visible channel data, tagged with the session it belongs to so a
 *  sessionId change can never observe the previous session's state. */
interface ChannelData {
  sessionId: string
  state: TerminalState | null
  snapshot: TerminalSnapshot | null
}
const emptyData = (sessionId: string): ChannelData => ({ sessionId, state: null, snapshot: null })

export function useTerminalChannel(sessionId: string, supported: boolean): TerminalChannel {
  const hub = useWsHub()
  const [data, setData] = useState<ChannelData>(() => emptyData(sessionId))
  // Render-time state adjustment (the usePendingRequestChannel pattern): if
  // the sessionId prop changed, replace the data with an empty one for the
  // new session. React retries the render before committing, so callers never
  // observe "new sessionId + old state/snapshot" in a single frame.
  if (data.sessionId !== sessionId) {
    setData(emptyData(sessionId))
  }
  const state = data.state
  const snapshot = data.snapshot

  /** Current generation anchor: null = no terminal frame seen yet (the
   *  no-snapshot seed case), '' = idle (no live generation), uuid = live. */
  const anchorRef = useRef<string | null>(null)
  /** Last applied output seq within the anchored generation. */
  const lastSeqRef = useRef(0)
  /** A terminal-resync is unanswered: drop output until the snapshot
   *  re-anchors (delivering chunks the snapshot also contains would double-
   *  apply them, and a gap means chunks are missing anyway). */
  const resyncPendingRef = useRef(false)
  const outputListenersRef = useRef(new Set<(data: string) => void>())
  /** The restored-idle snapshot already auto-created — fires once per
   *  snapshot object (a re-render or an unchanged snapshot never re-fires). */
  const autoCreatedRef = useRef<TerminalSnapshot | null>(null)

  const subscribeOutput = useCallback((cb: (data: string) => void) => {
    outputListenersRef.current.add(cb)
    return () => { outputListenersRef.current.delete(cb) }
  }, [])

  const create = useCallback((cols: number, rows: number) => {
    hub.send({ kind: 'terminal-create', sessionId, cols, rows })
  }, [hub, sessionId])

  const input = useCallback((data: string) => {
    hub.send({ kind: 'terminal-input', sessionId, terminalId: anchorRef.current ?? '', data })
  }, [hub, sessionId])

  const resize = useCallback((cols: number, rows: number) => {
    hub.send({ kind: 'terminal-resize', sessionId, terminalId: anchorRef.current ?? '', cols, rows })
  }, [hub, sessionId])

  const close = useCallback(() => {
    localStorage.removeItem(terminalBindingKey(sessionId))
    hub.send({ kind: 'terminal-close', sessionId })
  }, [hub, sessionId])

  useEffect(() => {
    if (!supported) return
    // Fresh channel per (session, supported): drop any previous anchor.
    anchorRef.current = null
    lastSeqRef.current = 0
    resyncPendingRef.current = false
    autoCreatedRef.current = null

    const bindingKey = terminalBindingKey(sessionId)
    // Visible-data writer with the session check inside the functional
    // update: a frame dispatched for the previous session between the prop
    // change and this effect's cleanup must not write into the new one.
    const writeData = (patch: Partial<Omit<ChannelData, 'sessionId'>>) => {
      setData((prev) => (prev.sessionId !== sessionId ? prev : { ...prev, sessionId, ...patch }))
    }
    const requestResync = (terminalId: string) => {
      if (resyncPendingRef.current) return
      resyncPendingRef.current = true
      hub.send({ kind: 'terminal-resync', sessionId, terminalId })
    }

    const listener = (frame: WsServerFrame) => {
      switch (frame.kind) {
        case 'terminal-snapshot': {
          const snap = frame.snapshot
          anchorRef.current = snap.terminalId
          lastSeqRef.current = snap.seq
          resyncPendingRef.current = false
          writeData({ state: snap.state, snapshot: snap })
          if (snap.state.status === 'running' && snap.terminalId) {
            localStorage.setItem(bindingKey, snap.terminalId)
          }
          break
        }
        case 'terminal-state': {
          if (frame.state.status === 'idle') {
            // Server-confirmed clear (local close or another tab's): the
            // association is gone. Late output from the dead generation is
            // fenced by the '' anchor below.
            anchorRef.current = ''
            lastSeqRef.current = 0
            resyncPendingRef.current = false
            localStorage.removeItem(bindingKey)
          } else {
            if (frame.terminalId !== anchorRef.current) {
              // A generation we have no screen for — re-anchor (see header).
              anchorRef.current = frame.terminalId
              lastSeqRef.current = 0
              requestResync(frame.terminalId)
            }
            if (frame.state.status === 'running') {
              localStorage.setItem(bindingKey, frame.terminalId)
            }
          }
          writeData({ state: frame.state })
          break
        }
        case 'terminal-output': {
          if (anchorRef.current === null) {
            // No snapshot seed arrived: the first terminal frame of any kind
            // anchors the channel (no deadlock on a snapshot that may never
            // come). Seq starts at 0, so a contiguous first chunk flows.
            anchorRef.current = frame.terminalId
            lastSeqRef.current = 0
          }
          if (frame.terminalId !== anchorRef.current) {
            requestResync(frame.terminalId)
            return
          }
          if (resyncPendingRef.current) return
          if (frame.seq <= lastSeqRef.current) return
          if (frame.seq > lastSeqRef.current + 1) {
            requestResync(frame.terminalId)
            return
          }
          lastSeqRef.current = frame.seq
          for (const cb of outputListenersRef.current) cb(frame.data)
          break
        }
      }
    }

    const off = hub.addSessionListener(sessionId, listener)
    const release = hub.subscribeTerminal(sessionId)
    return () => {
      off()
      release()
    }
  }, [hub, sessionId, supported])

  // Restart auto-create: a remembered tab (stored binding) meeting a
  // restored-idle snapshot spawns the fresh shell at the persisted size.
  useEffect(() => {
    if (!supported || !snapshot) return
    if (!snapshot.restored || snapshot.state.status !== 'idle') return
    if (autoCreatedRef.current === snapshot) return
    if (!localStorage.getItem(terminalBindingKey(sessionId))) return
    autoCreatedRef.current = snapshot
    hub.send({ kind: 'terminal-create', sessionId, cols: snapshot.state.cols, rows: snapshot.state.rows })
  }, [hub, sessionId, supported, snapshot])

  return useMemo<TerminalChannel>(
    () => ({ supported, state, snapshot, subscribeOutput, create, input, resize, close }),
    [supported, state, snapshot, subscribeOutput, create, input, resize, close],
  )
}
