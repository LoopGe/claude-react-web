// Per-session view onto the shared WebSocket hub.
//
// Replaces the old per-session SSE connection. All frames arrive on
// the single hub connection owned by <WsHubProvider>; this hook
// filters by sessionId and dispatches to local state + injected
// permission handlers. One hub connection serves all panels regardless
// of how many Chat components are mounted.
//
// The `queuedAhead` counter optimistically tracks turns this tab
// posted that haven't seen a matching `result` yet — the server FIFO-
// queues turns but doesn't expose depth, so we count locally.

import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useWsHub, useWsHubStatus } from './useWsHub'
import type { WsServerFrame } from '../ws-types'
import type { PermissionRequest, PermissionResolved, SdkMessage } from '../types'

// In-memory LRU cache: session → last known messages. Lets the UI show a
// previous session's transcript instantly on switch instead of waiting for
// the server replay. The server remains the source of truth — the cache is
// just a warm-start hint that gets replaced once the fresh replay arrives.
const MSG_CACHE_MAX = 5
const msgCache = new Map<string, SdkMessage[]>()
function cacheGet(id: string): SdkMessage[] | undefined {
  const entry = msgCache.get(id)
  if (entry) { msgCache.delete(id); msgCache.set(id, entry) } // bump LRU
  return entry
}
function cacheSet(id: string, msgs: SdkMessage[]) {
  if (msgCache.has(id)) msgCache.delete(id)
  msgCache.set(id, msgs)
  if (msgCache.size > MSG_CACHE_MAX) {
    const oldest = msgCache.keys().next().value!
    msgCache.delete(oldest)
  }
}
/** Append a live message to the cache entry if it exists. Creates a new
 *  array so the cached reference never aliases React state. */
function cacheAppend(id: string, msg: SdkMessage) {
  const entry = msgCache.get(id)
  if (entry) msgCache.set(id, [...entry, msg])
}
/** Clear all cached messages. Used in tests to avoid cross-test leaks. */
export function cacheClear() {
  msgCache.clear()
}

export interface ContextUsage {
  totalTokens?: number
  maxTokens?: number
  rawMaxTokens?: number
  percentage?: number
  model?: string
}

export type ActivePhase =
  | 'thinking'
  | 'writing'
  | { type: 'tool_use'; name: string }
  | null

export interface ChatStream {
  messages: SdkMessage[]
  queuedAhead: number
  error: string | null
  /** Latest context-usage snapshot pushed by the server mid-stream. */
  contextUsage: ContextUsage | null
  /** Live output token rate (tok/s) computed from streaming deltas. Null when not streaming. */
  tokenRate: number | null
  /** Accumulated text from content_block_delta events during an active
   *  assistant turn. Null when not streaming. Enables character-by-
   *  character rendering instead of waiting for the final message. */
  streamingContent: string | null
  /** Current phase of the active assistant turn: thinking, writing text,
   *  or calling a specific tool. Null when not working. */
  activePhase: ActivePhase
  /** Permission decisions keyed by toolUseId. Fed from permission-resolved
   *  frames so plan cards can flip from pending to approved/rejected even
   *  when the SDK doesn't emit a tool_result (e.g. ExitPlanMode). */
  permissionDecisions: ReadonlyMap<string, 'allow' | 'deny'>
  /** False while the initial replay from the server is still buffering.
   *  Consumers can use this to show a loading skeleton instead of an
   *  empty "no messages" state when switching sessions. */
  replayReady: boolean
  /** Bump the queued counter by one (call after POST /messages succeeds). */
  trackSentTurn: () => void
  /** Clear all local state — used when switching between sessions. */
  reset: () => void
  /** Clear just the error banner. */
  clearError: () => void
}

export interface PermissionHandlers {
  onRequest: (req: PermissionRequest) => void
  onResolved: (res: PermissionResolved) => void
}

export function useChatStream(sessionId: string, permissions: PermissionHandlers): ChatStream {
  const [messages, setMessages] = useState<SdkMessage[]>([])
  const [queuedAhead, setQueuedAhead] = useState(0)
  const [opError, setOpError] = useState<string | null>(null)
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null)
  const [tokenRate, setTokenRate] = useState<number | null>(null)
  const tokenSampleRef = useRef<{ tokens: number; ts: number } | null>(null)
  const [streamingContent, setStreamingContent] = useState<string | null>(null)
  const [activePhase, setActivePhase] = useState<ActivePhase>(null)
  const [permissionDecisions, setPermissionDecisions] = useState<Map<string, 'allow' | 'deny'>>(() => new Map())
  /** pid → toolUseId mapping so we can resolve permission decisions to the
   *  correct tool_use block when permission-resolved fires. */
  const pidToToolUseRef = useRef(new Map<string, string>())
  /** Last message UUID for incremental sync. Updated on replay-done and
   *  each live message so the hub can send it with re-subscribe frames
   *  after a connection drop, avoiding full history replay. */
  const lastUuidRef = useRef<string | null>(null)
  const streamBufRef = useRef<string[]>([])
  /** Ref-based buffer for replay frames. Accumulates all replay chunks
   *  and flushes to state once on `replay-done`, avoiding the O(n²)
   *  `setMessages(prev => [...prev, ...chunk])` pattern that caused
   *  stutter when switching to sessions with large histories. */
  const replayBufRef = useRef<SdkMessage[]>([])
  /** Set to true once the first replay-done arrives. Used to drive
   *  loading indicators — `false` means we're still buffering. */
  const [replayReady, setReplayReady] = useState(false)

  const hub = useWsHub()

  // Stash the permission handlers in a ref so changing them doesn't
  // re-run the subscribe effect (which would briefly unsubscribe and
  // re-subscribe from the hub, causing the server to resend a full
  // replay and the UI to blink).
  const permsRef = useRef(permissions)
  useEffect(() => {
    permsRef.current = permissions
  })

  // Reset per-session state when sessionId changes. Uses
  // useLayoutEffect so the reset happens before paint but avoids both
  // react-hooks/set-state-in-effect and react-hooks/refs.
  const prevSessionRef = useRef(sessionId)
  useLayoutEffect(() => {
    if (prevSessionRef.current !== sessionId) {
      prevSessionRef.current = sessionId
      // Warm-start from LRU cache: show previous messages instantly
      // instead of a loading skeleton while the server replays.
      const cached = cacheGet(sessionId)
      setMessages(cached ?? [])
      setReplayReady(!!cached)
      // Restore lastUuid from cache so incremental sync works on
      // the next subscribe.
      lastUuidRef.current = cached?.length
        ? ((cached[cached.length - 1] as { uuid?: string }).uuid ?? null)
        : null
      setContextUsage(null)
      setQueuedAhead(0)
      setTokenRate(null)
      tokenSampleRef.current = null
      streamBufRef.current = []
      setStreamingContent(null)
      setActivePhase(null)
      setPermissionDecisions(new Map())
      pidToToolUseRef.current.clear()
      replayBufRef.current = []
    }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return

    // Buffer messages that arrive BEFORE the replay completes into a
    // single commit. The server guarantees per-session frame order:
    //   {replay*, replay-done, (message|permission-request|...)*}
    // For small histories (≤50 msgs) this is a single replay + done.
    // For large histories the server chunks into 50-message replay
    // batches followed by a replay-done that carries the permissions.
    // Either way, we append on each replay frame and flush on done.
    let replayDone = false
    const pending: SdkMessage[] = []

    // Use the session-scoped listener: the hub pre-filters by sessionId
    // so we avoid the O(N panels) scan that `addListener` would do on
    // every frame. This is the key change that prevents one panel's
    // high-traffic session from delaying another panel's updates.
    const off = hub.addSessionListener(sessionId, (frame: WsServerFrame) => {
      switch (frame.kind) {
        case 'replay': {
          // If replayDone is already true, the server re-broadcasts the
          // full replay after a reconnect — reset buffer to avoid duplicating.
          if (replayDone) {
            replayDone = false
            pending.length = 0
            replayBufRef.current = [...(frame.messages as SdkMessage[])]
          } else {
            // Chunked replay: accumulate into ref buffer. We only flush
            // to React state once on replay-done, avoiding O(n²) spread.
            replayBufRef.current.push(...(frame.messages as SdkMessage[]))
          }
          // Permissions are on the first chunk only for small replays;
          // for chunked replays they arrive on replay-done instead.
          if (frame.permissions?.length) {
            for (const p of frame.permissions ?? []) {
              permsRef.current.onRequest(p)
            }
          }
          break
        }
        case 'replay-done': {
          replayDone = true
          // Single flush: accumulated replay + any live messages that
          // arrived during the replay window. One setState call instead
          // of N chunk-appends — eliminates the O(n²) re-render cascade.
          const all = [...replayBufRef.current, ...pending]
          startTransition(() => {
            setMessages(all)
            replayBufRef.current = []
            pending.length = 0
            setReplayReady(true)
          })
          // Warm the LRU cache so the next switch to this session is instant.
          cacheSet(sessionId, all)
          // Track last message UUID for incremental sync.
          if (all.length > 0) {
            const uuid = (all[all.length - 1] as { uuid?: string }).uuid
            if (uuid) {
              lastUuidRef.current = uuid
              hub.setLastMessageUuid(sessionId, uuid)
            }
          }
          // Chunked replay: permissions ride on the final replay-done.
          if (frame.permissions?.length) {
            for (const p of frame.permissions ?? []) {
              permsRef.current.onRequest(p)
            }
          }
          break
        }
        case 'message': {
          const m = frame.message as SdkMessage
          if (!replayDone) {
            pending.push(m)
            return
          }
          // startTransition coalesces rapid successive message frames
          // (e.g. streaming tool-use deltas) into fewer re-renders.
          startTransition(() => {
            setMessages((prev) => [...prev, m])
          })
          cacheAppend(sessionId, m)
          // Track last message UUID for incremental sync.
          const msgUuid = (m as { uuid?: string }).uuid
          if (msgUuid) {
            lastUuidRef.current = msgUuid
            hub.setLastMessageUuid(sessionId, msgUuid)
          }
          // Compute live token rate from stream_event message_delta
          // events. The SDK's message_delta carries cumulative
          // output_tokens for the current response, so we diff against
          // the previous sample to get instantaneous throughput.
          if (m.type === 'stream_event') {
            const event = m.event as Record<string, unknown> | undefined
            if (event?.type === 'message_delta') {
              const usage = (event as { usage?: Record<string, unknown> }).usage
              const outputTokens = usage?.output_tokens as number | undefined
              if (outputTokens != null) {
                const now = performance.now()
                const prev = tokenSampleRef.current
                if (prev) {
                  const dt = (now - prev.ts) / 1000
                  const dTokens = outputTokens - prev.tokens
                  if (dt >= 0.3 && dTokens >= 0) {
                    setTokenRate(Math.round(dTokens / dt))
                    tokenSampleRef.current = { tokens: outputTokens, ts: now }
                  }
                } else {
                  tokenSampleRef.current = { tokens: outputTokens, ts: now }
                }
              }
            } else if (event?.type === 'message_stop') {
              tokenSampleRef.current = null
            }
            // Track content block boundaries for phase indicator.
            if (event?.type === 'content_block_start') {
              const cb = (event as { content_block?: Record<string, unknown> }).content_block
              if (cb?.type === 'thinking') {
                setActivePhase('thinking')
              } else if (cb?.type === 'text') {
                setActivePhase('writing')
              } else if (cb?.type === 'tool_use') {
                setActivePhase({ type: 'tool_use', name: String(cb.name ?? 'tool') })
              }
            }
            // Accumulate text deltas for live streaming render.
            if (event?.type === 'content_block_delta') {
              const delta = (event as { delta?: Record<string, unknown> }).delta
              const text = delta?.text
              if (typeof text === 'string') {
                streamBufRef.current.push(text)
                setStreamingContent(streamBufRef.current.join(''))
              }
            }
            if (event?.type === 'message_stop') {
              // Flush: the final assistant message will arrive shortly
              // and replace this intermediate state.
              streamBufRef.current = []
              setStreamingContent(null)
            }
          }
          if (m.type === 'result') {
            // Reset to 0 — the server's `working` flag (session-update)
            // will re-show the queue bar if more turns are pending.
            setQueuedAhead(0)
            setTokenRate(null)
            tokenSampleRef.current = null
            streamBufRef.current = []
            setStreamingContent(null)
            setActivePhase(null)
          }
          break
        }
        case 'permission-request': {
          permsRef.current.onRequest(frame.payload)
          // Track pid → toolUseId so we can resolve decisions later.
          const req = frame.payload as PermissionRequest
          if (req.id && req.toolUseID) {
            pidToToolUseRef.current.set(req.id, req.toolUseID)
          }
          break
        }
        case 'permission-resolved': {
          permsRef.current.onResolved({
            id: frame.id,
            ...frame.decision,
          })
          // Map the resolved pid back to toolUseId and record the decision.
          const toolUseId = pidToToolUseRef.current.get(frame.id)
          if (toolUseId) {
            pidToToolUseRef.current.delete(frame.id)
            setPermissionDecisions((prev) => {
              const next = new Map(prev)
              next.set(toolUseId, frame.decision.behavior)
              return next
            })
          }
          break
        }
        case 'context-usage': {
          setContextUsage(frame.usage as ContextUsage)
          break
        }
        case 'error': {
          // Session-scoped error from the hub (usually "unknown session").
          // Surface it in the panel banner but don't tear down state;
          // the server might still be starting up.
          setOpError(frame.message)
          break
        }
        default:
          break
      }
    })

    const release = hub.subscribe(sessionId, lastUuidRef.current ?? undefined)
    return () => {
      off()
      release()
    }
  }, [hub, sessionId])

  // Hub status → per-panel banner. Derived via useMemo to avoid calling
  // setState inside an effect (react-hooks/set-state-in-effect).
  const hubStatus = useWsHubStatus()
  const displayedError = useMemo(() => {
    if (hubStatus === 'reconnecting')
      return opError === null || opError === 'Stream reconnecting…'
        ? 'Stream reconnecting…'
        : opError
    if (hubStatus === 'online') return opError === 'Stream reconnecting…' ? null : opError
    return opError
  }, [opError, hubStatus])

  // Cap at 1 — we don't know how many turns the SDK will emit for queued
  // messages (it may merge them), so a true count would inflate. The
  // server's `working` flag drives the real "Working" indicator; this
  // counter only controls the "N more messages queued" bar.
  const trackSentTurn = useCallback(() => {
    setQueuedAhead((n) => Math.max(n, 1))
  }, [])

  const reset = useCallback(() => {
    setMessages([])
    setQueuedAhead(0)
    setOpError(null)
    setContextUsage(null)
    setTokenRate(null)
    tokenSampleRef.current = null
    replayBufRef.current = []
    setReplayReady(false)
    streamBufRef.current = []
    setStreamingContent(null)
    setActivePhase(null)
    setPermissionDecisions(new Map())
    pidToToolUseRef.current.clear()
    lastUuidRef.current = null
  }, [])

  const clearError = useCallback(() => setOpError(null), [])

  return useMemo(
    () => ({ messages, queuedAhead, error: displayedError, contextUsage, tokenRate, streamingContent, activePhase, permissionDecisions, replayReady, trackSentTurn, reset, clearError }),
    [messages, queuedAhead, displayedError, contextUsage, tokenRate, streamingContent, activePhase, permissionDecisions, replayReady, trackSentTurn, reset, clearError],
  )
}
