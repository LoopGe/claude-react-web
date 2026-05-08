// EventSource subscription hooks.
//
// Two public helpers:
// - useSSE: specialized for the main /sessions/:id/stream channel (replay /
//   replay-done / message events, shapes are SdkMessage).
// - useNamedEventSource: a generic dispatcher that takes a map of
//   `eventName → (parsedJson) => void` handlers. Used for the permission
//   channel and anywhere else we want arbitrary named events.

import { useEffect, useRef } from 'react'
import type { SdkMessage } from '../types'

export interface SseHandlers {
  onReplay?: (msg: SdkMessage) => void
  onReplayDone?: () => void
  onMessage?: (msg: SdkMessage) => void
  onError?: (err: Event) => void
  onOpen?: () => void
}

export function useSSE(url: string | null, handlers: SseHandlers) {
  // Keep handlers in a ref so changing them doesn't tear down the connection.
  // The assignment MUST happen inside an effect, not during render — React 19
  // may invoke render multiple times before commit, and writing a ref mid-
  // render captures the wrong handler closure. The sync effect runs before
  // the main subscription effect on every render, so EventSource callbacks
  // always see the current handlers without the connection being rebuilt.
  const ref = useRef(handlers)
  useEffect(() => {
    ref.current = handlers
  })

  useEffect(() => {
    if (!url) return
    const es = new EventSource(url)

    const safeParse = (s: string): SdkMessage | null => {
      try {
        return JSON.parse(s) as SdkMessage
      } catch {
        return null
      }
    }

    const onReplay = (ev: MessageEvent) => {
      const msg = safeParse(ev.data)
      if (msg) ref.current.onReplay?.(msg)
    }
    const onReplayDone = () => ref.current.onReplayDone?.()
    const onMessage = (ev: MessageEvent) => {
      const msg = safeParse(ev.data)
      if (msg) ref.current.onMessage?.(msg)
    }
    const onError = (ev: Event) => ref.current.onError?.(ev)
    const onOpen = () => ref.current.onOpen?.()

    es.addEventListener('replay', onReplay)
    es.addEventListener('replay-done', onReplayDone)
    es.addEventListener('message', onMessage)
    es.addEventListener('error', onError)
    es.addEventListener('open', onOpen)

    return () => {
      es.removeEventListener('replay', onReplay)
      es.removeEventListener('replay-done', onReplayDone)
      es.removeEventListener('message', onMessage)
      es.removeEventListener('error', onError)
      es.removeEventListener('open', onOpen)
      es.close()
    }
  }, [url])
}

/**
 * Generic named-event EventSource hook.
 *
 * Each key in `events` is an SSE `event:` name; its value is invoked with
 * the parsed JSON payload. `onError` / `onOpen` fire for the underlying
 * connection lifecycle. Handlers are held in a ref so the connection
 * survives re-renders.
 */
export function useNamedEventSource(
  url: string | null,
  events: Record<string, (data: unknown) => void>,
  lifecycle: { onError?: (e: Event) => void; onOpen?: () => void } = {},
) {
  // See the comment in useSSE — refs must be updated in an effect, not at
  // render time, otherwise React 19 may persist a partially-rendered value.
  const eventsRef = useRef(events)
  const lifeRef = useRef(lifecycle)
  useEffect(() => {
    eventsRef.current = events
    lifeRef.current = lifecycle
  })

  useEffect(() => {
    if (!url) return
    const es = new EventSource(url)
    const boundHandlers: Array<[string, (ev: MessageEvent) => void]> = []

    for (const name of Object.keys(events)) {
      const fn = (ev: MessageEvent) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(ev.data)
        } catch {
          parsed = null
        }
        eventsRef.current[name]?.(parsed)
      }
      es.addEventListener(name, fn)
      boundHandlers.push([name, fn])
    }
    const onError = (ev: Event) => lifeRef.current.onError?.(ev)
    const onOpen = () => lifeRef.current.onOpen?.()
    es.addEventListener('error', onError)
    es.addEventListener('open', onOpen)

    return () => {
      for (const [name, fn] of boundHandlers) es.removeEventListener(name, fn)
      es.removeEventListener('error', onError)
      es.removeEventListener('open', onOpen)
      es.close()
    }
    // We intentionally only re-run on URL change or events-map identity
    // change. The set of event names is assumed stable for the lifetime of
    // a given url — callers keep their handler object referentially stable
    // (e.g. via useMemo or by moving logic into a ref) to avoid tear-down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, Object.keys(events).sort().join(',')])
}
