import type { AgentMessage } from '../../agent-message.js'
import type { RawLine } from '../../history-reader.js'
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

export type SubscribeNativeSubagentLive = (
  sessionId: string,
  emit: (frame: AgentMessage) => void,
  onTermination: (error: Error) => void,
) => (() => void) | null

interface NativeSubagentTranscriptSourceOptions {
  stateDir: string
  /** Null means the session is dormant: serve disk only and never resume it. */
  subscribeLive: SubscribeNativeSubagentLive
}

type OutputItem = { frame: SubagentTranscriptFrame } | { error: Error }

function uuidOf(frame: unknown): string | null {
  const uuid = (frame as { uuid?: unknown }).uuid
  return typeof uuid === 'string' ? uuid : null
}

function isPromptFrame(frame: unknown): boolean {
  const value = frame as { type?: unknown; parent_tool_use_id?: unknown }
  return value.type === 'user' && value.parent_tool_use_id === null
}

function findGenuinePrompt(lines: RawLine[], agentId: string, sessionId: string): unknown | undefined {
  for (const line of lines) {
    if (line.type !== 'user' || line.parent_tool_use_id !== agentId) continue
    const projected = projectNativeSubagentLine(line, sessionId)
    if (projected !== undefined && isPromptFrame(projected)) return projected
  }
  return undefined
}

function hasVisibleOrigin(lines: RawLine[], agentId: string): boolean {
  for (const line of lines) {
    if (line.type !== 'assistant') continue
    const content = (line.message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const value of content) {
      if (typeof value !== 'object' || value === null) continue
      const block = value as { type?: unknown; id?: unknown; name?: unknown }
      if (block.type === 'tool_use' && block.id === agentId &&
        (block.name === 'Agent' || block.name === 'Task' || block.name === 'Explore')) {
        return true
      }
    }
  }
  return false
}

/** Live native sidechain projection over the manager's existing fan-out.
 * Every subscriber owns its input buffer, output queue and catalog-read state;
 * no watcher consumes NativeSession.messages directly or can await the pump.
 * Snapshot, projection and unexpected inner-termination failures all reject
 * the output iterable; normal unsubscribe/close is the only silent EOF. */
export class NativeSubagentTranscriptSource implements SubagentTranscriptSource {
  private readonly subscriptions = new Set<() => void>()

  constructor(private readonly opts: NativeSubagentTranscriptSourceOptions) {}

  subscribeSubagentTranscript(sessionId: string, agentId: string): SubagentTranscriptSub {
    const output = createPushable<OutputItem>(`native-subagent[${sessionId}:${agentId}]`)
    const iterable: AsyncIterable<SubagentTranscriptFrame> = {
      [Symbol.asyncIterator]: () => {
        const inner = output.iterable[Symbol.asyncIterator]()
        return {
          next: async (): Promise<IteratorResult<SubagentTranscriptFrame>> => {
            const item = await inner.next()
            if (item.done) return { done: true, value: undefined }
            if ('error' in item.value) throw item.value.error
            return { done: false, value: item.value.frame }
          },
          return: async (): Promise<IteratorResult<SubagentTranscriptFrame>> => {
            await inner.return?.()
            return { done: true, value: undefined }
          },
        }
      },
    }
    const buffered: AgentMessage[] = []
    const seen = new Set<string>()
    let active = true
    let snapshotReady = false
    let draining = false
    let promptResolved = false
    let done = false
    let unsubscribeLive: (() => void) | null = null

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
        output.push({ frame: { sessionId, agentId, reset, frames: fresh } })
      }
    }

    const processLive = async (frame: AgentMessage): Promise<void> => {
      const projected = (frame as { parent_tool_use_id?: unknown }).parent_tool_use_id === agentId
        ? projectNativeSubagentLine(frame as RawLine, sessionId)
        : undefined
      if (!promptResolved) {
        if (projected !== undefined && isPromptFrame(projected)) {
          promptResolved = true
        } else {
          const loaded = await nativeHistoryCache.load(this.opts.stateDir, sessionId)
          if (!active) return
          const genuine = loaded
            ? findGenuinePrompt(loaded.lines, agentId, sessionId)
            : undefined
          if (genuine !== undefined) {
            promptResolved = true
            push(false, [genuine])
          } else {
            const entry = loaded?.subagents.byId.get(agentId)
            if (entry) {
              const prompt = nativeSubagentPromptFrame(entry, sessionId)
              if (prompt !== null) {
                push(false, [prompt])
                promptResolved = true
              } else if (entry.prompt !== undefined || (loaded && hasVisibleOrigin(loaded.lines, agentId))) {
                // A visible origin with no usable prompt proves unavailability.
                // Descriptor-only evidence can instead be a late-origin race.
                promptResolved = true
              }
            }
          }
        }
      }
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
      void drain().catch(failChannel)
    }

    const unsubscribe = (): void => {
      if (done) return
      done = true
      active = false
      unsubscribeLive?.()
      buffered.length = 0
      output.end()
      this.subscriptions.delete(unsubscribe)
    }

    const failChannel = (cause: unknown): void => {
      if (done) return
      done = true
      active = false
      unsubscribeLive?.()
      buffered.length = 0
      this.subscriptions.delete(unsubscribe)
      const pending = output.drainQueue()
      const initialReset = pending.find((item) => 'frame' in item && item.frame.reset)
      // An already-produced reset precedes the failure even for a consumer
      // that has not pulled yet; later queued increments are stale and drop.
      if (initialReset) output.push(initialReset)
      output.push({ error: cause instanceof Error ? cause : new Error(String(cause)) })
      output.end()
    }

    // Register synchronously BEFORE the first snapshot await. Live frames are
    // only buffered here, so even a catalog read cannot block the session pump.
    unsubscribeLive = this.opts.subscribeLive(sessionId, (frame) => {
      if (!active) return
      buffered.push(frame)
      if (snapshotReady) scheduleDrain()
    }, failChannel)
    this.subscriptions.add(unsubscribe)

    void (async () => {
      const snapshot = await readNativeSubagentTranscript(this.opts.stateDir, sessionId, agentId)
      if (!active) return
      if (snapshot.some(isPromptFrame)) promptResolved = true
      push(true, snapshot)
      snapshotReady = true
      scheduleDrain()
    })().catch(failChannel)

    return { iterable, unsubscribe }
  }

  close(): void {
    for (const unsubscribe of [...this.subscriptions]) unsubscribe()
    this.subscriptions.clear()
  }
}
