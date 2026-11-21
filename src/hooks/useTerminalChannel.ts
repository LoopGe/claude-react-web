// Per-session terminal channel over the WS hub — the data layer of the
// terminal overlay (TerminalOverlay/TerminalBody own the rendering).
//
// Render isolation (the streaming rule): live output churn touches ONLY refs
// and the leaf-level subscribeOutput listener set — never React state — so
// the hook's host does not re-render per chunk. State/snapshot transitions
// (spawn / exit / close / attach seed / resync answer) and the rare transient
// control-error notice are the only renders.
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
//
// Screen anchoring is SYNCHRONOUS: subscribeAnchor listeners run inside the
// snapshot dispatch (and an idle state frame synthesizes the cleared anchor),
// never in a passive effect — an output frame dispatched between a snapshot
// and a later React commit would otherwise be written and then wiped by the
// anchor rewrite. A fresh subscriber is seeded immediately with the latest
// anchor so a body mounting after the dispatch never reads stale state.
//
// Control errors (`terminal-error` frames) are terminal-local transient
// notices — deliberately NOT the prose `error` frame the session
// synchronizer renders as the persistent chat error bar. input/resize are
// guarded on a live anchor so idle fit / exited resize never send a doomed
// frame in the first place.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalSnapshot, TerminalState, TerminalStatus } from '../../shared/terminal.js'
import type { WsServerFrame } from '../ws-types'
import { terminalBindingKey } from '../constants/storageKeys'
import { useWsHub } from './useWsHub'

/** How long a terminal-local control-error notice stays visible. */
const TERMINAL_ERROR_NOTICE_MS = 5000

export interface TerminalChannel {
  /** From SessionInfo.terminalSupported — false renders the unavailable panel. */
  supported: boolean
  /** Current lifecycle state; re-renders the host ONLY on transitions. */
  state: TerminalState | null
  /** Latest attach/resync seed (screen + generation + seq it reflects). */
  snapshot: TerminalSnapshot | null
  /** Transient terminal-local control-error notice (auto-clears). */
  error: string | null
  /** Leaf-level live-output subscription — zero host re-renders per chunk. */
  subscribeOutput(cb: (data: string) => void): () => void
  /** Leaf-level screen-anchor subscription. The callback runs SYNCHRONOUSLY
   *  inside the snapshot dispatch (before any later output frame), and is
   *  seeded immediately with the latest anchor on registration. */
  subscribeAnchor(cb: (snapshot: TerminalSnapshot) => void): () => void
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
  error: string | null
}
const emptyData = (sessionId: string): ChannelData => ({ sessionId, state: null, snapshot: null, error: null })

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
  /** Last known lifecycle status (null = no state/snapshot seen yet). The
   *  input/resize guard reads it alongside the anchor. */
  const statusRef = useRef<TerminalStatus | null>(null)
  /** A terminal-resync is unanswered: drop output until the snapshot
   *  re-anchors (delivering chunks the snapshot also contains would double-
   *  apply them, and a gap means chunks are missing anyway). */
  const resyncPendingRef = useRef(false)
  const outputListenersRef = useRef(new Set<(data: string) => void>())
  const anchorListenersRef = useRef(new Set<(snapshot: TerminalSnapshot) => void>())
  /** Latest anchor, updated synchronously on dispatch — the seed source for
   *  a subscribeAnchor registration that lands after the snapshot frame. */
  const snapshotRef = useRef<TerminalSnapshot | null>(null)
  /** The restored-idle snapshot already auto-created — fires once per
   *  snapshot object (a re-render or an unchanged snapshot never re-fires). */
  const autoCreatedRef = useRef<TerminalSnapshot | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const subscribeOutput = useCallback((cb: (data: string) => void) => {
    outputListenersRef.current.add(cb)
    return () => { outputListenersRef.current.delete(cb) }
  }, [])

  const subscribeAnchor = useCallback((cb: (snapshot: TerminalSnapshot) => void) => {
    anchorListenersRef.current.add(cb)
    // Immediate seed: a body mounting AFTER the snapshot dispatch applies
    // the current screen synchronously, never a stale committed-state read.
    const snap = snapshotRef.current
    if (snap) cb(snap)
    return () => { anchorListenersRef.current.delete(cb) }
  }, [])

  const create = useCallback((cols: number, rows: number) => {
    hub.send({ kind: 'terminal-create', sessionId, cols, rows })
  }, [hub, sessionId])

  /** Live-anchor guard shared by input/resize: no frame without a live
   *  generation. '' / null anchor = idle or pre-seed (an idle fit must not
   *  send a doomed resize); a known non-running status = dead generation.
   *  A uuid anchor with null status is the output-adopted generation (no
   *  snapshot seed yet) — live by definition, so control ops flow. */
  const liveAnchor = useCallback((): string | null => {
    const anchor = anchorRef.current
    if (!anchor) return null
    if (statusRef.current !== null && statusRef.current !== 'running') return null
    return anchor
  }, [])

  const input = useCallback((data: string) => {
    const anchor = liveAnchor()
    if (!anchor) return
    hub.send({ kind: 'terminal-input', sessionId, terminalId: anchor, data })
  }, [hub, sessionId, liveAnchor])

  const resize = useCallback((cols: number, rows: number) => {
    const anchor = liveAnchor()
    if (!anchor) return
    hub.send({ kind: 'terminal-resize', sessionId, terminalId: anchor, cols, rows })
  }, [hub, sessionId, liveAnchor])

  const close = useCallback(() => {
    localStorage.removeItem(terminalBindingKey(sessionId))
    hub.send({ kind: 'terminal-close', sessionId })
  }, [hub, sessionId])

  useEffect(() => {
    if (!supported) return
    // Fresh channel per (session, supported): drop any previous anchor.
    anchorRef.current = null
    lastSeqRef.current = 0
    statusRef.current = null
    resyncPendingRef.current = false
    snapshotRef.current = null
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
    // Synchronous screen anchor: listeners run INSIDE the dispatch, before
    // any later output frame can be written (the passive-effect rewrite
    // raced them — see header).
    const applyAnchor = (snap: TerminalSnapshot) => {
      snapshotRef.current = snap
      for (const cb of anchorListenersRef.current) cb(snap)
    }

    const listener = (frame: WsServerFrame) => {
      switch (frame.kind) {
        case 'terminal-snapshot': {
          const snap = frame.snapshot
          anchorRef.current = snap.terminalId
          lastSeqRef.current = snap.seq
          statusRef.current = snap.state.status
          resyncPendingRef.current = false
          applyAnchor(snap)
          writeData({ state: snap.state, snapshot: snap })
          if (snap.state.status === 'running' && snap.terminalId) {
            localStorage.setItem(bindingKey, snap.terminalId)
          }
          break
        }
        case 'terminal-state': {
          statusRef.current = frame.state.status
          if (frame.state.status === 'idle') {
            // Server-confirmed clear (local close, another tab's, or a
            // server-side dispose): the association is gone. Late output
            // from the dead generation is fenced by the '' anchor below.
            anchorRef.current = ''
            lastSeqRef.current = 0
            resyncPendingRef.current = false
            localStorage.removeItem(bindingKey)
            // The clear also empties the screen server-side (killAndClear).
            // The state frame carries no screen, so synthesize the cleared
            // anchor: the body resets and a stale restored badge/banner
            // cannot outlive the close.
            const cleared: TerminalSnapshot = {
              terminalId: '', seq: 0, screen: '', state: frame.state, restored: false,
            }
            applyAnchor(cleared)
            writeData({ state: frame.state, snapshot: cleared })
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
            writeData({ state: frame.state })
          }
          break
        }
        case 'terminal-error': {
          // Terminal-local transient notice — never the transcript error bar.
          writeData({ error: frame.message })
          if (errorTimerRef.current !== null) clearTimeout(errorTimerRef.current)
          errorTimerRef.current = setTimeout(() => {
            errorTimerRef.current = null
            writeData({ error: null })
          }, TERMINAL_ERROR_NOTICE_MS)
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
      if (errorTimerRef.current !== null) {
        clearTimeout(errorTimerRef.current)
        errorTimerRef.current = null
      }
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
    () => ({ supported, state, snapshot, error: data.error, subscribeOutput, subscribeAnchor, create, input, resize, close }),
    [supported, state, snapshot, data.error, subscribeOutput, subscribeAnchor, create, input, resize, close],
  )
}
