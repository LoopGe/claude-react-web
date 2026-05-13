import { createInitialSessionState, type SessionAction, type SessionSnapshot, type SessionState } from './types'
import { reduceSessionState } from './reducer'

type Listener = () => void

export class SessionStore {
  private state: SessionState
  private snapshot: SessionSnapshot
  private listeners = new Set<Listener>()
  private flushTimer: number | null = null

  constructor(sessionId: string) {
    this.state = createInitialSessionState(sessionId)
    this.snapshot = buildSnapshot(this.state)
  }

  getState(): SessionState {
    return this.state
  }

  getSnapshot(): SessionSnapshot {
    return this.snapshot
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispatch(action: SessionAction): void {
    const next = reduceSessionState(this.state, action)
    if (next === this.state) return
    this.state = next
    this.snapshot = buildSnapshot(next)
    this.scheduleFlush()
    this.emit()
  }

  dispatchMany(actions: SessionAction[]): void {
    if (actions.length === 0) return
    let next = this.state
    for (const action of actions) {
      next = reduceSessionState(next, action)
    }
    if (next === this.state) return
    this.state = next
    this.snapshot = buildSnapshot(next)
    this.scheduleFlush()
    this.emit()
  }

  reset(): void {
    if (this.flushTimer != null) {
      window.clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.dispatch({ type: 'RESET' })
  }

  destroy(): void {
    if (this.flushTimer != null) {
      window.clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.listeners.clear()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private scheduleFlush(): void {
    if (!this.state.liveTurn?.dirty || this.flushTimer != null) return
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null
      this.dispatch({ type: 'LIVE_TURN_FLUSH' })
    }, 33)
  }
}

function buildSnapshot(state: SessionState): SessionSnapshot {
  return {
    replayReady: state.replayReady,
    items: state.items,
    messages: state.messages,
    streamingContent: state.liveTurn?.flushedText ?? null,
    activePhase: state.liveTurn?.phase ?? null,
    tokenRate: state.liveTurn?.tokenRate ?? null,
    contextUsage: state.contextUsage,
    error: state.error,
    queuedAhead: state.queuedAhead,
    permissionDecisions: state.permissionDecisions,
    planStatus: state.planStatus,
    activeSubagents: Array.from(state.activeSubagents.values()),
    lastMessageUuid: state.lastMessageUuid,
  }
}
