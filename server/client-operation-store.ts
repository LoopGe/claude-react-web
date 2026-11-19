// Per-session idempotency sidecar for user sends (spec §8.3, T7b Task 3).
// Maps a client-supplied `clientOperationId` (the optimistic placeholder uuid
// the browser mints before POST) to the server-minted prompt uuid + receivedAt
// of the dispatch it produced. A retried POST carrying the same key — the
// recovering-409 retry loop, or a lost ACK the user re-sends — returns the
// ORIGINAL ack instead of minting a second prompt.
//
// One bounded JSON array per session under <stateDir>/client-operations/<id>.json
// (modeled on PromptUuidStore / PerSessionSidecar): per-session serial writes,
// remove tombstone + revive, LRU cache. The window is capped so a long session
// does not grow the file without bound; a retry older than the window is a
// stale re-send and dispatches anew (acceptable — the original turn is long
// finished).

import { join } from 'node:path'
import { PerSessionSidecar } from './per-session-sidecar.js'

export interface ClientOperationEntry {
  clientOperationId: string
  /** The server-minted prompt uuid the original dispatch produced. */
  promptUuid: string
  /** receivedAt stamped on the original prompt (echoed in the idempotent ack). */
  receivedAt?: number
}

/** Newest entries retained per session. */
const CAP = 256

export class ClientOperationStore {
  private readonly sidecar: PerSessionSidecar<ClientOperationEntry>
  constructor(stateDir: string | undefined) {
    this.sidecar = new PerSessionSidecar({
      dir: stateDir ? join(stateDir, 'client-operations') : null,
      label: 'client-operations',
    })
  }

  /** The recorded dispatch for a clientOperationId, or null when unseen
   *  (first send, or a retry older than the retention window). */
  async get(sessionId: string, clientOperationId: string): Promise<ClientOperationEntry | null> {
    const entries = await this.sidecar.load(sessionId)
    return entries?.find((e) => e.clientOperationId === clientOperationId) ?? null
  }

  /** The session's retained entries (newest last), or null when absent. */
  load(sessionId: string): Promise<ClientOperationEntry[] | null> {
    return this.sidecar.load(sessionId)
  }

  /** Record (or refresh) the dispatch a clientOperationId produced. Bounded to
   *  the newest CAP entries; a repeat key replaces its prior entry in place. */
  record(sessionId: string, entry: ClientOperationEntry): Promise<void> {
    return this.sidecar.update(sessionId, (prev) => {
      const list = (prev ?? []).filter((e) => e.clientOperationId !== entry.clientOperationId)
      list.push(entry)
      return list.slice(-CAP)
    })
  }

  remove(sessionId: string, opts?: { strict?: boolean }): Promise<void> {
    return this.sidecar.remove(sessionId, opts)
  }

  revive(sessionId: string): void {
    this.sidecar.revive(sessionId)
  }
}