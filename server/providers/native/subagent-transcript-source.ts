import type { AgentMessage } from '../../agent-message.js'
import type { RawLine } from '../../history-reader.js'
import { createLogger } from '../../log.js'
import { createPushable } from '../../pushable.js'
import type {
  SubagentTranscriptFrame,
  SubagentTranscriptSub,
} from '../../subagent-transcript-hub.js'
import type { SubagentTranscriptSource } from '../../subagent-transcript-source.js'
import { nativeHistoryCache } from './session-log/cache.js'
import {
  nativeSubagentPromptFrame,
  projectNativeSubagentLine,
  readNativeSubagentTranscript,
} from './subagent-transcripts.js'

const log = createLogger('native-subagent-transcripts')

export type SubscribeNativeSubagentLive = (
  sessionId: string,
  emit: (frame: AgentMessage) => void,
) => (() => void) | null

interface NativeSubagentTranscriptSourceOptions {
  stateDir: string
  /** Null means the session is dormant: serve disk only and never resume it. */
  subscribeLive: SubscribeNativeSubagentLive
}

function uuidOf(frame: unknown): string | null {
  const uuid = (frame as { uuid?: unknown }).uuid
  return typeof uuid === 'string' ? uuid : null
}

function isPromptFrame(frame: unknown): boolean {
  const value = frame as { type?: unknown; parent_tool_use_id?: unknown }
  return value.type === 'user' && value.parent_tool_use_id === null
}

/** Live native sidechain projection over the manager's existing fan-out.
 * Every subscriber owns its input buffer, output queue and catalog-read state;
 * no watcher consumes NativeSession.messages directly or can await the pump. */
export class NativeSubagentTranscriptSource implements SubagentTranscriptSource {
  private readonly subscriptions = new Set<() => void>()

  constructor(private readonly opts: NativeSubagentTranscriptSourceOptions) {}

  subscribeSubagentTranscript(sessionId: string, agentId: string): SubagentTranscriptSub {
    const output = createPushable<SubagentTranscriptFrame>(`native-subagent[${sessionId}:${agentId}]`)
    const buffered: AgentMessage[] = []
    const seen = new Set<string>()
    let active = true
    let snapshotReady = false
    let draining = false
    let promptResolved = false

    const push = (reset: boolean, frames: unknown[]): void => {
      if (!active) return
      const fresh: unknown[] = []
      for (const frame of frames) {
        const uuid = uuidOf(frame)
        if (uuid !== null) {
          if (seen.has(uuid)) continue
          seen.add(uuid)
        }
        fresh.push(frame)
      }
      if (reset || fresh.length > 0) {
        output.push({ sessionId, agentId, reset, frames: fresh })
      }
    }

    const processLive = async (frame: AgentMessage): Promise<void> => {
      if (!promptResolved) {
        const loaded = await nativeHistoryCache.load(this.opts.stateDir, sessionId)
        if (!active) return
        const entry = loaded?.subagents.byId.get(agentId)
        if (entry) {
          const prompt = nativeSubagentPromptFrame(entry, sessionId)
          if (prompt !== null) push(false, [prompt])
          promptResolved = true
        }
      }
      if ((frame as { parent_tool_use_id?: unknown }).parent_tool_use_id !== agentId) return
      const projected = projectNativeSubagentLine(frame as RawLine, sessionId)
      if (projected === undefined) return
      if (isPromptFrame(projected)) promptResolved = true
      push(false, [projected])
    }

    const drain = async (): Promise<void> => {
      if (draining || !snapshotReady || !active) return
      draining = true
      try {
        while (active && buffered.length > 0) {
          await processLive(buffered.shift()!)
        }
      } finally {
        draining = false
      }
      if (active && buffered.length > 0) scheduleDrain()
    }

    const scheduleDrain = (): void => {
      void drain().catch((err) => {
        if (active) log.warn(`live projection failed session=${sessionId} agent=${agentId}: ${(err as Error).message}`)
      })
    }

    // Register synchronously BEFORE the first snapshot await. Live frames are
    // only buffered here, so even a catalog read cannot block the session pump.
    const unsubscribeLive = this.opts.subscribeLive(sessionId, (frame) => {
      if (!active) return
      buffered.push(frame)
      if (snapshotReady) scheduleDrain()
    })

    let done = false
    const unsubscribe = (): void => {
      if (done) return
      done = true
      active = false
      unsubscribeLive?.()
      buffered.length = 0
      output.end()
      this.subscriptions.delete(unsubscribe)
    }
    this.subscriptions.add(unsubscribe)

    void (async () => {
      const snapshot = await readNativeSubagentTranscript(this.opts.stateDir, sessionId, agentId)
      if (!active) return
      if (snapshot.some(isPromptFrame)) promptResolved = true
      push(true, snapshot)
      snapshotReady = true
      scheduleDrain()
    })().catch((err) => {
      if (active) log.warn(`snapshot read failed session=${sessionId} agent=${agentId}: ${(err as Error).message}`)
    })

    return { iterable: output.iterable, unsubscribe }
  }

  close(): void {
    for (const unsubscribe of [...this.subscriptions]) unsubscribe()
    this.subscriptions.clear()
  }
}
