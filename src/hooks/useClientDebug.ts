// Client-debug answerer — the browser half of the dev-only `appdebug`
// client-debug channel.
//
// Listens on the WS hub's global fan-out for `client-debug-request` frames
// (the host asks this tab to run one DOM debug op), executes the op, and
// answers via POST /client-debug/:id/answer. Multiple tabs may all answer;
// the server's broker is first-answer-wins, so a duplicate answer is a
// harmless 404.
//
// EVERY request must be answered — success or failure — because the host's
// MCP tool call is parked until the first answer or the broker timeout.
// Mount once, at the App root.

import { useEffect } from 'react'
import type { ClientDebugAnswer } from '../../shared/client-debug.js'
import { executeClientDebugOp } from '../client-debug/executor'
import { api } from './useApi'
import { useWsHub } from './useWsHub'

export function useClientDebug(): void {
  const hub = useWsHub()

  useEffect(() => {
    return hub.addListener((frame) => {
      if (frame.kind !== 'client-debug-request') return
      const req = frame
      // Execute and answer are two independent steps: an error POSTing a
      // SUCCESSFUL answer (e.g. 404 — another tab won the first-answer race,
      // or a transient blip) must NOT turn into a second { ok: false }
      // answer for the same request. The answer's own failure is swallowed —
      // the host broker's timeout reaps unanswered requests.
      void (async () => {
        let answer: ClientDebugAnswer
        try {
          answer = { ok: true, result: await executeClientDebugOp(req.op, req.params) }
        } catch (e) {
          answer = { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
        api.post(`/client-debug/${req.id}/answer`, answer).catch(() => {})
      })()
    })
  }, [hub])
}
