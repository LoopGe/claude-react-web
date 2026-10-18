//
// Bootstrap + live ingest for one subagent's on-disk transcript, rendered
// through MessageList. The transcript lives in a SCRATCH SessionStore under
// a synthetic registry id (never the session's real store — its frames
// never entered the main stream, which is exactly why this dialog reads
// disk). The registry's refCount + idle TTL sweep reclaims the scratch
// store after the dialog closes; concurrent dialogs on the same agent
// share one store.
//
// Flow: REST full fetch → REPLAY_REPLACE (bootstrap), then WS
// `subagent-transcript` frames — reset:true goes through REPLAY_REPLACE
// again (idempotent handover after reconnect), increments go through
// MESSAGE (applyMessage append).

import { useEffect } from 'react'
import { api } from './useApi'
import { useWsHub } from './useWsHub'
import { useSessionField } from '../session-store/selectors'
import { sessionStoreRegistry } from '../session-store/registry'
import { formatError } from '../utils/format-error'
import type { SdkMessage } from '../types'

export function subagentStoreId(sessionId: string, agentId: string): string {
  return `${sessionId}::subagent::${agentId}`
}

export function useSubagentTranscriptStore(
  sessionId: string,
  agentId: string,
): { replayReady: boolean; error: string | null } {
  const hub = useWsHub()
  const storeId = subagentStoreId(sessionId, agentId)
  const replayReady = useSessionField(storeId, 'replayReady')
  const error = useSessionField(storeId, 'error')

  useEffect(() => {
    sessionStoreRegistry.retain(storeId)
    const store = sessionStoreRegistry.getOrCreate(storeId)
    let cancelled = false

    // Both payloads are history-reader-normalized, reducer-ready frames;
    // the wire types them loosely, the reducer contract is SdkMessage.
    api.get<{ messages?: SdkMessage[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}`,
    )
      .then((res) => {
        if (cancelled) return
        store.dispatch({ type: 'REPLAY_REPLACE', permissions: [], messages: res?.messages ?? [] })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        store.dispatch({ type: 'ERROR', message: formatError(err) })
      })

    const removeListener = hub.addSessionListener(sessionId, (frame) => {
      if (frame.kind !== 'subagent-transcript') return
      if (frame.agentId !== agentId) return
      // The server serves history-reader-normalized frames ("ready for the
      // client reducer" per shared/ws-protocol.ts); the wire types them
      // unknown[] but the reducer contract is SdkMessage.
      const f = frame as { reset: boolean; frames: SdkMessage[] }
      if (f.reset) {
        store.dispatch({ type: 'REPLAY_REPLACE', permissions: [], messages: f.frames })
      } else {
        for (const message of f.frames) store.dispatch({ type: 'MESSAGE', message })
      }
    })
    const releaseChannel = hub.subscribeSubagentTranscript(sessionId, agentId)

    return () => {
      cancelled = true
      removeListener()
      releaseChannel()
      sessionStoreRegistry.release(storeId)
    }
  }, [hub, sessionId, agentId, storeId])

  return { replayReady, error }
}
