import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import type { ApiError } from './useApi'
import type { SdkMessage } from '../types'
import type { SessionSearchHit } from '../../shared/session-search'
import type { TranscriptPageResponse } from '../../shared/transcript-page'

/** What the preview panel is centered on: a search hit (seq is known) or a
 *  CommandPalette message hit (uuid only). */
export type MessagePreviewTarget =
  | { kind: 'hit'; hit: SessionSearchHit; query: string }
  | { kind: 'uuid'; uuid: string; query: string }

export interface PreviewMessage {
  seq: number
  uuid?: string
  msg: SdkMessage
}

export interface PreviewPage extends Omit<TranscriptPageResponse, 'messages'> {
  messages: PreviewMessage[]
}

export interface MessagePreviewState {
  page: PreviewPage | null
  loading: boolean
  error: 'not-found' | 'failed' | null
  retry: () => void
}

/** 20 messages on each side of the target — enough turn context without
 *  turning the panel into a second transcript. */
export const PREVIEW_LIMIT = 41

/**
 * Fetch the centered page shown by the search panel's drill-in preview. The
 * preview is a snapshot: it does not follow live frames and never touches the
 * session's transcript window.
 */
interface PreviewResult {
  /** Identifies the request this result belongs to. A mismatched key means a
   *  newer target/retry is in flight, so the caller shows loading. */
  key: string
  page: PreviewPage | null
  error: 'not-found' | 'failed' | null
}

export function useMessagePreview(
  sessionId: string,
  target: MessagePreviewTarget,
): MessagePreviewState {
  const [result, setResult] = useState<PreviewResult | null>(null)
  const [attempt, setAttempt] = useState(0)
  const requestIdRef = useRef(0)

  const key =
    target.kind === 'hit'
      ? `${sessionId}|hit|${target.hit.messageSeq}|${attempt}`
      : `${sessionId}|uuid|${target.uuid}|${attempt}`

  useEffect(() => {
    const requestId = ++requestIdRef.current
    const requestKey = key
    const ac = new AbortController()
    const path =
      target.kind === 'hit'
        ? `/sessions/${sessionId}/messages?around=${target.hit.messageSeq}&limit=${PREVIEW_LIMIT}`
        : `/sessions/${sessionId}/messages?aroundUuid=${encodeURIComponent(target.uuid)}&limit=${PREVIEW_LIMIT}`

    api
      .get<TranscriptPageResponse>(path, { signal: ac.signal })
      .then((page) => {
        // A newer target (or a retry) has superseded this request.
        if (requestId !== requestIdRef.current) return
        setResult({ key: requestKey, page: page as PreviewPage, error: null })
      })
      .catch((error: unknown) => {
        if (ac.signal.aborted || requestId !== requestIdRef.current) return
        const status = (error as ApiError).status
        setResult({
          key: requestKey,
          page: null,
          error: status === 404 ? 'not-found' : 'failed',
        })
      })

    return () => ac.abort()
  }, [sessionId, target, key])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  // No synchronous loading state: a result whose key does not match the
  // current request IS the loading state, which also covers target changes
  // without a setState-in-effect.
  const current = result?.key === key ? result : null
  return {
    page: current?.page ?? null,
    loading: current === null,
    error: current?.error ?? null,
    retry,
  }
}