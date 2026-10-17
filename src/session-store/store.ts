import { createInitialSessionState, type ServerMirror, type SessionAction, type SessionSnapshot, type SessionState, type LiveTurnSegment } from './types'
import { reduceSessionState } from './reducer'
import type { SdkMessage } from '../types'
import { PLAN_TOOL_NAMES, SUBAGENT_TOOL_NAMES, ENTER_PLAN_MODE_TOOL_NAME } from '../constants/toolNames'

type Listener = () => void

/** How often the live (in-progress) assistant turn is flushed to a new
 *  snapshot during streaming. Each flush re-renders the streaming footer,
 *  so this directly bounds the per-second render cost of an active turn.
 *  ~80ms (~12fps) reads as smooth for streaming prose while cutting the
 *  render volume to roughly a third of a per-frame (33ms / 30fps) flush. */
const LIVE_TURN_FLUSH_MS = 80

/** Joined `flushedText` memo. buildSnapshot runs on every dispatch, but the
 *  segment array's identity only changes on LIVE_TURN_FLUSH / pruning, so a
 *  WeakMap keyed by the array keeps the common case O(1) while the join
 *  itself stays bounded by in-flight (un-pruned) text. */
const streamedTextMemo = new WeakMap<LiveTurnSegment[], string>()
function joinLiveTurnSegments(segments: LiveTurnSegment[]): string {
  const memoed = streamedTextMemo.get(segments)
  if (memoed !== undefined) return memoed
  const joined = segments.map((s) => s.text).join('')
  streamedTextMemo.set(segments, joined)
  return joined
}

export class SessionStore {
  private state: SessionState
  private snapshot: SessionSnapshot
  private listeners = new Set<Listener>()
  private flushTimer: number | null = null
  /** Per-instance subagent filter cache — moved off module scope so
   *  multiple SessionStore instances (multi-panel layouts) don't
   *  thrash a shared single-slot cache against each other. */
  private cachedSubagentsMap: ServerMirror['activeSubagents'] | null = null
  private cachedRunningSubagents: SessionSnapshot['activeSubagents'] = []
  /** Per-instance Workflow filter cache — mirrors cachedSubagentsMap so
   *  the running-workflow list only reallocates when activeWorkflows
   *  actually changes (drives any future Workflow pill in WorkingBubble). */
  private cachedWorkflowsMap: ServerMirror['activeWorkflows'] | null = null
  private cachedRunningWorkflows: SessionSnapshot['activeWorkflows'] = []

  constructor(sessionId: string) {
    registerStoreForDebug(sessionId, this)
    // The seq-window store (transcript-seq refactor, Task 7) holds NO client
    // persistence: no localStorage transcript cache, no IndexedDB layer. The
    // constructor is therefore synchronous and trivially "ready" — there is
    // no hydrate to defer and no cache state to settle before subscribing.
    // Opening a session = REST tail page + WS subscribe (Task 8); the old
    // hydrateReady/idbReady snapshot gates read as constant `true` so their
    // consumers keep compiling until Task 8 removes the gates.
    this.state = createInitialSessionState(sessionId)
    this.snapshot = this.buildSnapshot(this.state)
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
    this.snapshot = this.buildSnapshot(next)
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
    this.snapshot = this.buildSnapshot(next)
    this.scheduleFlush()
    this.emit()
  }

  /** Wipe the transcript and mark it ready (replayReady=true). Shared by
   *  reset() and clearPersisted(). The post-wipe state is "live and empty" —
   *  the window is empty (generation/headSeq preserved until the server's
   *  WINDOW_BUMP re-anchors it), there is no pending replay, so replayReady
   *  MUST be true or MessageList sits on the skeleton forever. Cancels the
   *  flushTimer first so a pending live-turn flush can't fire after the
   *  mirror is rebuilt. */
  private wipe(): void {
    if (this.flushTimer != null) {
      window.clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.dispatch({ type: 'CLEAR_TRANSCRIPT' })
  }

  reset(): void {
    this.wipe()
  }

  /** Wipe the in-memory transcript. Historically this also erased the
   *  localStorage + IndexedDB caches; the seq-window store keeps no client
   *  persistence, so there is nothing left to erase. Legacy pre-refactor
   *  cache keys are handled solely by the boot-time sweep
   *  (legacy-transcript-cache.ts). Used by the /clear flow. */
  clearPersisted(): void {
    this.wipe()
  }

  /** Permanently drop a session's store (registry.delete path). With no
   *  persistence layer there is nothing to drain — cancel timers and drop
   *  listeners. (Legacy pre-refactor localStorage keys are handled solely by
   *  the boot-time sweep — see legacy-transcript-cache.ts.) */
  async purge(): Promise<void> {
    unregisterStoreForDebug(this.state.sessionId, this)
    if (this.flushTimer != null) {
      window.clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.listeners.clear()
  }

  /** Tear down the store: cancel timers, drop listeners. (The idle sweep's
   *  old save-then-teardown durability concern is gone with the persistence
   *  layer.) registry.delete uses purge() instead. */
  async destroy(): Promise<void> {
    unregisterStoreForDebug(this.state.sessionId, this)
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
    if (!this.state.mirror.liveTurn?.dirty || this.flushTimer != null) return
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null
      this.dispatch({ type: 'LIVE_TURN_FLUSH' })
    }, LIVE_TURN_FLUSH_MS)
  }

  private buildSnapshot(state: SessionState): SessionSnapshot {
    const mirror = state.mirror
    const intent = state.intent
    // Render-time merge: optimistic placeholders live in intent (so server
    // frame handlers can't wipe them) but components see them at the tail
    // of items/messages, same as pre-refactor. Identity-stable short-circuit
    // when no placeholders are pending (the common case).
    const items = intent.pendingPlaceholders.size === 0
      ? mirror.items
      : [...mirror.items, ...intent.pendingPlaceholders.values()]
    const messages = intent.pendingPlaceholders.size === 0
      ? mirror.messages
      : [...mirror.messages, ...Array.from(intent.pendingPlaceholders.values()).map((p) => p.msg)]
    const win = mirror.window
    return {
      replayReady: mirror.replayReady,
      hydrateReady: true,
      idbReady: true,
      items,
      messages,
      streamingContent: mirror.liveTurn ? joinLiveTurnSegments(mirror.liveTurn.flushedText) : null,
      activePhase: mirror.liveTurn?.phase ?? null,
      tokenRate: mirror.liveTurn?.tokenRate ?? null,
      contextUsage: mirror.contextUsage,
      promptSuggestion: mirror.promptSuggestion ?? null,
      tasks: mirror.tasks,
      apiRetry: mirror.apiRetry,
      thinkingTokens: mirror.thinkingTokens,
      sessionState: mirror.sessionState,
      error: intent.error,
      permissionDecisions: mirror.permissionDecisions,
      planStatus: mirror.planStatus,
      planContent: mirror.planContent,
      questionAnswers: mirror.questionAnswers,
      toolStatus: mirror.toolStatus,
      toolResults: mirror.toolResults,
      activeSubagents: this.getRunningSubagents(mirror.activeSubagents),
      subagentIndex: mirror.activeSubagents,
      activeWorkflows: this.getRunningWorkflows(mirror.activeWorkflows),
      workflowIndex: mirror.activeWorkflows,
      // Exposed unfiltered — a Skill card must still find its record after the
      // call settles (the drill-in stays open/reopenable), and skills feed no
      // running-only sibling, so there is nothing to filter for.
      skillIndex: mirror.activeSkills,
      lastMessageUuid: mirror.lastMessageUuid,
      // Seq window view (Tasks 8/9 consume): loadOlder pages before=oldestSeq
      // gated on hasOlder; MessageList anchors firstItemIndex on oldestSeq;
      // reconnect/hole handling compares these snapshots.
      oldestSeq: win.oldestSeq,
      newestSeq: win.newestSeq,
      hasOlder: win.hasOlder,
      hasNewer: win.hasNewer,
      generation: win.generation,
      headSeq: win.headSeq,
      hole: win.hole,
      cacheHasDroppedMedia: false,
    }
  }

  /** Per-instance equivalent of the old module-global running-subagents
   *  cache. The Map reference is compared by identity so the filtered
   *  array is only reallocated when activeSubagents actually changes.
   *
   *  Includes `background` (async subagents whose launch ack has landed but
   *  whose real completion hasn't — they're still working in the background
   *  and must stay in the WorkingBubble's subagent pill) alongside `running`, AND
   *  `pending` (the post-turn-end form of `background`): the WorkingBubble
   *  stays mounted in its `Waiting` state while any `pending` subagent
   *  remains, so the user sees that background work is still in flight after
   *  the parent turn ended. A `pending` subagent is dismissible (via the × in
   *  SubagentOverlay — not from the bar itself, whose pill only drills in). */
  private getRunningSubagents(map: ServerMirror['activeSubagents']): SessionSnapshot['activeSubagents'] {
    if (map === this.cachedSubagentsMap) return this.cachedRunningSubagents
    this.cachedSubagentsMap = map
    this.cachedRunningSubagents = Array.from(map.values())
      .filter((s) => s.status === 'running' || s.status === 'background' || s.status === 'pending')
    return this.cachedRunningSubagents
  }

  /** Workflow analogue of getRunningSubagents. The Map reference is compared
   *  by identity so the filtered array is only reallocated when activeWorkflows
   *  actually changes. Reserved for a future Workflow pill (if/when wired);
   *  the full index (workflowIndex) is exposed unfiltered so
   *  WorkflowCard can read completed records too. */
  private getRunningWorkflows(map: ServerMirror['activeWorkflows']): SessionSnapshot['activeWorkflows'] {
    if (map === this.cachedWorkflowsMap) return this.cachedRunningWorkflows
    this.cachedWorkflowsMap = map
    this.cachedRunningWorkflows = Array.from(map.values()).filter((w) => w.status === 'running')
    return this.cachedRunningWorkflows
  }
}

// ---------------------------------------------------------------------------
// On-demand debug dump
// ---------------------------------------------------------------------------
//
// When a tool card is visibly stuck on 'running', you don't need to reproduce
// anything or trawl localStorage — just open the DevTools console and run:
//
//     __crwDumpToolStatus()
//
// It prints, per live session, every toolStatus entry plus a focused list of
// the ones still 'running'. For each stuck id it tries to find the originating
// tool_use (so you see the tool name) and reports whether a tool_result with
// that id exists anywhere in the message log. That single dump distinguishes
// the failure modes:
//   • running + NO tool_result in log  → result never arrived (interrupt /
//     disconnect / process died). The reducer's turn-end sweep only helps if
//     a `result` frame later lands.
//   • running + tool_result EXISTS in log → id-mismatch: the result is there
//     but its tool_use_id didn't match the seeded id (normalize.ts bug).
//
// It ALSO reports `orphans`: every tool_result that did NOT merge into its
// card (so MessageList draws a standalone bubble). Each orphan is tagged
// `isExcludedByDesign` and carries a `diagnosis`. Subagent orphans get a
// `subagentRecord` cross-check (present? status? result captured?) so a
// healthy merged subagent (suppressed, never an orphan) is told apart from a
// degraded one (record pruned / result lost → bare card + reappearing bubble,
// the turn-end-wipe failure mode). The orphan "consumed" test mirrors
// MessageList.makeResultConsumed EXACTLY — including subagentResultIds — so
// the dump agrees with what's actually on screen.
//
// And `subagents`: a snapshot of the activeSubagents index (label / status /
// toolCount / hasResult) — the map SubagentCard reads from. Empty or missing
// records here while a card is on screen = the card is rendering its fallback.
//
// Multiple records may share a sessionId in split-panel mode; `storeIndex`
// disambiguates them.
//
// Paste the output back and we can name the root cause with certainty.

const debugStores = new Map<string, Set<SessionStore>>()

function registerStoreForDebug(sessionId: string, store: SessionStore): void {
  if (!import.meta.env.DEV) return
  let set = debugStores.get(sessionId)
  if (!set) {
    set = new Set()
    debugStores.set(sessionId, set)
  }
  set.add(store)
}

function unregisterStoreForDebug(sessionId: string, store: SessionStore): void {
  if (!import.meta.env.DEV) return
  const set = debugStores.get(sessionId)
  if (!set) return
  set.delete(store)
  if (set.size === 0) debugStores.delete(sessionId)
}

// --- DEV-only on-demand dump infrastructure ---
// Gated on import.meta.env.DEV so Vite tree-shakes it out of the production
// bundle (matching __dumpGroupState in App.tsx). `debugStores` +
// register/unregister stay live because the SessionStore constructor/destroy
// paths call them, but they no-op outside dev. The block below is intentionally
// NOT re-indented to keep the diff reviewable.
if (import.meta.env.DEV) {
interface ToolEntryDump {
  toolUseId: string
  status: string
  toolName: string | null
  /** A tool_result block with this exact tool_use_id exists somewhere in
   *  the message log. */
  hasToolResultInLog: boolean
  /** The is_error flag on that tool_result (null when no result found). */
  resultIsError: boolean | null
  /** The parent_tool_use_id of the user frame carrying the tool_result
   *  (null = main-thread / undefined field; string = subagent-internal).
   *  Critical for diagnosing the pump-drop failure mode: if a result
   *  exists ONLY on disk but never reached the live reducer, the live
   *  message log won't contain it at all. */
  resultParentToolUseId: string | null | 'no-result'
  diagnosis: string
}

/** One tool_result block in the live message log that did NOT get merged
 *  into its originating tool card (so MessageList draws it as a standalone
 *  "orphan" bubble). The headline field is `isExcludedByDesign`: it splits
 *  expected orphans (Plan/Question/Subagent — excluded from the merge map
 *  on purpose, they own their own rendering) from REAL orphans (a generic
 *  tool whose result should have merged but didn't — a matching bug). */
interface OrphanResultDump {
  toolUseId: string
  /** Tool name resolved from the originating tool_use, null if none found
   *  in the live log (result with no matching tool_use — a different bug). */
  toolName: string | null
  /** True when the tool is in TOOL_STATUS_EXCLUDE — orphan bubble is the
   *  EXPECTED fallback, the specific card (PlanCard/QuestionCard/Subagent)
   *  should be the real renderer. False = unexpected, investigate. */
  isExcludedByDesign: boolean
  /** Whether the id was seeded into toolStatus (a generic card exists for
   *  it). True here with an orphan result means the merge step skipped it. */
  hasSeededStatus: boolean
  /** parent_tool_use_id of the carrying user frame (null = main thread). */
  parentToolUseId: string | null
  /** Cross-check against the activeSubagents index (only populated for
   *  Subagent tools). Lets the dump tell apart a healthy merged subagent
   *  (record present + result captured → suppressed, NOT an orphan) from a
   *  broken one (record pruned / result lost → falls back to a bare card and
   *  the orphan bubble reappears — exactly the turn-end-wipe failure mode).
   *  null for non-subagent orphans. */
  subagentRecord: {
    present: boolean
    status: string | null
    hasResult: boolean
  } | null
  diagnosis: string
}

/** One entry of the activeSubagents index. The previous dump ignored this
 *  map entirely, so subagent merge/fallback bugs were invisible: the card
 *  reads its label/status/result straight from here, and MessageList derives
 *  orphan-suppression from `result`. Surfacing it makes "card degraded to a
 *  bare running placeholder" / "merged result vanished" diagnosable at a glance. */
interface SubagentDump {
  toolUseId: string
  label: string
  status: string
  toolCount: number
  /** True once the subagent's own tool_result merged into the card (record
   *  .result set). MessageList suppresses the orphan bubble exactly when this
   *  is true; false on a completed subagent means the result was lost. */
  hasResult: boolean
  resultIsError: boolean | null
  startedAt: number | null
  endedAt: number | null
}

interface ToolStatusDump {
  sessionId: string
  /** Index of the store within this session's store set — disambiguates the
   *  split-panel case where two panels hold the same session (the previous
   *  dump emitted two identical records with no way to tell them apart). */
  storeIndex: number
  total: number
  /** Quick counts so the headline failure mode is visible at a glance. */
  counts: { running: number; success: number; error: number }
  /** Every non-success tool entry, with per-id result analysis. The
   *  previous version only analyzed 'running' entries — useless once the
   *  turn-end sweep has flipped lingering 'running' tools to 'error'. */
  problems: ToolEntryDump[]
  /** tool_result blocks rendered as standalone orphan bubbles (not merged
   *  into a card). Each is tagged expected-vs-real so you can tell a
   *  by-design fallback from a genuine merge failure at a glance. */
  orphans: OrphanResultDump[]
  /** Snapshot of the activeSubagents index: every Agent/Task/Explore record
   *  with its status + whether its result merged into the card. */
  subagents: SubagentDump[]
  all: Record<string, string>
}

/** Per-message tool index, built ONCE per store so the problem/orphan scans
 *  are O(messages) instead of O(messages × ids). Maps every tool_use id to
 *  its name, and every tool_result's tool_use_id to its result metadata. */
interface ToolIndex {
  nameById: Map<string, string>
  resultById: Map<string, { isError: boolean; parentToolUseId: string | null }>
}

function buildToolIndex(messages: readonly SdkMessage[]): ToolIndex {
  const nameById = new Map<string, string>()
  const resultById = new Map<string, { isError: boolean; parentToolUseId: string | null }>()
  for (const m of messages) {
    const content = m.message?.content
    if (!Array.isArray(content)) continue
    const parent = m.parent_tool_use_id
    const parentToolUseId = typeof parent === 'string' ? parent : null
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === 'tool_use') {
        const id = typeof b.id === 'string' ? b.id : typeof b.tool_use_id === 'string' ? b.tool_use_id : null
        if (id && typeof b.name === 'string') nameById.set(id, b.name)
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        resultById.set(b.tool_use_id, { isError: b.is_error === true, parentToolUseId })
      }
    }
  }
  return { nameById, resultById }
}

/** Mirrors normalize.ts's TOOL_STATUS_EXCLUDE (not exported there). Tools
 *  here are intentionally kept out of the generic toolStatus/toolResults
 *  maps because they have dedicated renderers, so their tool_result lands
 *  as an orphan bubble by design. */
function isExcludedFromMerge(toolName: string | null): boolean {
  if (!toolName) return false
  return (
    PLAN_TOOL_NAMES.has(toolName) ||
    SUBAGENT_TOOL_NAMES.has(toolName) ||
    toolName === ENTER_PLAN_MODE_TOOL_NAME ||
    toolName === 'AskUserQuestion'
  )
}

function dumpToolStatus(): ToolStatusDump[] {
  const out: ToolStatusDump[] = []
  for (const [sessionId, stores] of debugStores) {
    let storeIndex = 0
    for (const store of stores) {
      const thisStoreIndex = storeIndex++
      const state = store.getState()
      const mirror = state.mirror
      const messages = mirror.messages
      // Build the id→name / id→result indexes once. The previous dump
      // re-scanned the full message log for every problem AND every orphan
      // (O(messages × ids)); on a 500-entry ring with many tools the dump
      // itself stalled. One pass up front makes every lookup O(1).
      const index = buildToolIndex(messages)
      // Subagent result ids: an Agent/Task/Explore whose own tool_result
      // merged into its card (record.result set). MessageList folds these
      // into makeResultConsumed to suppress the orphan bubble — the dump
      // MUST mirror that, or it misclassifies a healthy merged subagent as
      // an orphan (and, worse, tags it EXPECTED so the real turn-end-wipe
      // bug reads as "working as designed").
      const subagentResultIds = new Set<string>()
      for (const [id, sub] of mirror.activeSubagents) {
        if (sub.result) subagentResultIds.add(id)
      }
      const counts = { running: 0, success: 0, error: 0 }
      for (const status of mirror.toolStatus.values()) {
        if (status === 'running') counts.running++
        else if (status === 'success') counts.success++
        else if (status === 'error') counts.error++
      }
      const problems: ToolEntryDump[] = []
      for (const [id, status] of mirror.toolStatus) {
        // 'success' is the healthy terminal state — skip it.
        if (status === 'success') continue
        const toolName = index.nameById.get(id) ?? null
        const resultMeta = index.resultById.get(id)
        const hasResult = resultMeta != null
        const resultIsError = resultMeta ? resultMeta.isError : null
        const resultParent: string | null | 'no-result' = resultMeta
          ? resultMeta.parentToolUseId
          : 'no-result'
        let diagnosis: string
        if (!hasResult) {
          diagnosis =
            'NO tool_result in live message log — either the result never arrived ' +
            '(interrupt / disconnect / process died) OR the pump dropped it as an ' +
            'echoed user frame (parent_tool_use_id == null). Compare with the on-disk ' +
            'transcript: if the result IS on disk but missing here, it is a pump-drop bug.'
        } else if (status === 'error' && resultIsError === false) {
          diagnosis =
            'ID-MISMATCH / FLIP-FAILURE: a SUCCESS tool_result exists in the log but the ' +
            'status is error — the reducer did not flip it (id extraction mismatch in ' +
            'normalize.ts, or the result message reached the reducer out of band).'
        } else if (status === 'error' && resultIsError === true) {
          diagnosis = 'Genuine tool failure — tool_result carried is_error: true.'
        } else {
          diagnosis = `status=${status} with hasResult=${hasResult} isError=${resultIsError}`
        }
        problems.push({
          toolUseId: id,
          status,
          toolName,
          hasToolResultInLog: hasResult,
          resultIsError,
          resultParentToolUseId: resultParent,
          diagnosis,
        })
      }
      // EnterPlanMode ids — it has no lifecycle map (renders as a stateless
      // marker) yet still emits a tool_result. MessageList's predicate folds
      // these in to suppress the stray bubble; mirror that here so the
      // diagnostic agrees with what's actually rendered.
      const enterPlanIds = new Set<string>()
      for (const [id, name] of index.nameById) {
        if (name === ENTER_PLAN_MODE_TOOL_NAME) enterPlanIds.add(id)
      }
      // Orphan scan: the inverse of the loop above. Instead of starting
      // from seeded ids, walk every tool_result block in the live log and
      // ask "did this get consumed by a card?" The ones that didn't are
      // exactly what MessageList draws as standalone orphan bubbles.
      const orphans: OrphanResultDump[] = []
      const seenOrphanIds = new Set<string>()
      for (const m of messages) {
        const content = m.message?.content
        if (!Array.isArray(content)) continue
        const parent = m.parent_tool_use_id
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
          const id = b.tool_use_id
          // Consumed → not an orphan. This MUST mirror the render predicate
          // (MessageList.tsx makeResultConsumed): generic inline merge
          // (toolResults), PlanCard (planStatus), QuestionCard
          // (questionAnswers), the EnterPlanMode marker (enterPlanIds), OR a
          // subagent whose result already merged into its card
          // (subagentResultIds). The last term was the gap: without it a
          // healthy merged subagent was reported as an orphan AND tagged
          // EXPECTED, so the turn-end-wipe regression read as "by design".
          if (
            mirror.toolResults.has(id) ||
            mirror.planStatus.has(id) ||
            mirror.questionAnswers.has(id) ||
            enterPlanIds.has(id) ||
            subagentResultIds.has(id)
          ) {
            continue
          }
          if (seenOrphanIds.has(id)) continue
          seenOrphanIds.add(id)
          const toolName = index.nameById.get(id) ?? null
          const excluded = isExcludedFromMerge(toolName)
          const hasSeededStatus = mirror.toolStatus.has(id)
          // Subagent cross-check: for an Agent/Task/Explore orphan, look at
          // the activeSubagents record. It tells apart the two cases the old
          // dump conflated under one "EXPECTED" blanket.
          const isSubagentTool = toolName != null && SUBAGENT_TOOL_NAMES.has(toolName)
          const subRecord = isSubagentTool ? mirror.activeSubagents.get(id) : undefined
          const subagentRecord = isSubagentTool
            ? {
                present: subRecord != null,
                status: subRecord?.status ?? null,
                hasResult: subRecord?.result != null,
              }
            : null
          let diagnosis: string
          if (isSubagentTool) {
            // We only reach here when subagentResultIds did NOT contain the id
            // (else it was skipped as consumed above). So either the record is
            // gone or its result was never captured — the card has degraded to
            // a bare placeholder and this orphan bubble is the regression, not
            // a by-design fallback.
            if (!subRecord) {
              diagnosis =
                `REAL ORPHAN — subagent "${toolName}" has NO activeSubagents record, so ` +
                'SubagentCard falls back to a bare "running" placeholder and the result ' +
                'is not merged. Classic turn-end wipe: the record was pruned at the result ' +
                'frame (reducer.ts) before its result could be read.'
            } else if (!subRecord.result) {
              if (subRecord.status === 'background' || subRecord.status === 'pending') {
                diagnosis =
                  `OK (${subRecord.status}) — subagent "${toolName}" is an async subagent mid-flight ` +
                  '(launch ack landed, real completion not yet arrived). Its ack tool_result is ' +
                  'suppressed via the background consumed-set; no result is captured yet by design. ' +
                  "('pending' = the parent turn ended and the sweep flipped it from " +
                  "'background'; it is still in the running set, so the bar keeps " +
                  'showing it while completion is still expected.)'
              } else {
                diagnosis =
                  `REAL ORPHAN — subagent "${toolName}" record exists (status=${subRecord.status}) ` +
                  'but result was never captured, so the card cannot merge it. The merge step ' +
                  'in updateIndexes did not run (record not "running" when the result landed, ' +
                  'or an id mismatch).'
              }
            } else {
              // Shouldn't happen — result present means it was consumed above.
              diagnosis =
                `UNEXPECTED — subagent "${toolName}" has a captured result yet still surfaced ` +
                'as an orphan. subagentResultIds / makeResultConsumed are out of sync.'
            }
          } else if (excluded) {
            // Plan / Question results are normally consumed by their card
            // (planStatus / questionAnswers) and skipped above, so reaching
            // here for those is unusual — it means the lifecycle map was
            // pruned away while the result still lingers in the log.
            diagnosis =
              `EXPECTED-ish — "${toolName}" is excluded from the generic merge map by design ` +
              '(PlanCard / QuestionCard own it). Reaching here means its lifecycle map ' +
              '(planStatus / questionAnswers) no longer holds the id, so the card stopped ' +
              'consuming the result — investigate if a card is visibly missing.'
          } else if (toolName == null) {
            diagnosis =
              'NO matching tool_use in live log — the result arrived without (or before) ' +
              'its tool_use. Likely an out-of-order frame or a pump-drop of the assistant turn.'
          } else if (hasSeededStatus) {
            diagnosis =
              `REAL ORPHAN — "${toolName}" WAS seeded into toolStatus but its result was not ` +
              'merged into toolResults. The reducer merge step skipped it (see reducer.ts ' +
              'getToolResultEntries gate: toolStatus.has(id) && !toolResults.has(id)).'
          } else {
            diagnosis =
              `REAL ORPHAN — generic tool "${toolName}" never seeded into toolStatus, so its ` +
              'result could not merge. Likely an id-extraction mismatch in normalize.ts ' +
              '(getToolUseStarts) between the tool_use id and the tool_result tool_use_id.'
          }
          orphans.push({
            toolUseId: id,
            toolName,
            // A subagent orphan that reaches here is NEVER by-design (the
            // by-design ones were already skipped via subagentResultIds).
            isExcludedByDesign: excluded && !isSubagentTool,
            hasSeededStatus,
            parentToolUseId: typeof parent === 'string' ? parent : null,
            subagentRecord,
            diagnosis,
          })
        }
      }
      // Snapshot the activeSubagents index so subagent merge/fallback bugs
      // are directly visible (the old dump ignored this map entirely).
      const subagents: SubagentDump[] = []
      for (const [id, sub] of mirror.activeSubagents) {
        subagents.push({
          toolUseId: id,
          label: sub.label,
          status: sub.status,
          toolCount: sub.toolCount,
          hasResult: sub.result != null,
          resultIsError: sub.result ? sub.result.isError === true : null,
          startedAt: sub.startedAt ?? null,
          endedAt: sub.endedAt ?? null,
        })
      }
      const all: Record<string, string> = {}
      for (const [id, status] of mirror.toolStatus) all[id] = status
      out.push({
        sessionId,
        storeIndex: thisStoreIndex,
        total: mirror.toolStatus.size,
        counts,
        problems,
        orphans,
        subagents,
        all,
      })
    }
  }
  return out
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __crwDumpToolStatus?: () => ToolStatusDump[] }).__crwDumpToolStatus =
    dumpToolStatus

  /** Debug helper: dump liveTurn state for all sessions.
   *  Usage in DevTools console: __crwDumpLiveTurn() */
  ;(window as unknown as { __crwDumpLiveTurn?: () => void }).__crwDumpLiveTurn = () => {
    console.group('🔍 LiveTurn Debug')
    for (const [sessionId, stores] of debugStores) {
      let i = 0
      for (const store of stores) {
        const state = store.getState()
        const liveTurn = state.mirror.liveTurn
        const now = Date.now()
        const elapsed = liveTurn?.startedAt ? ((now - liveTurn.startedAt) / 1000).toFixed(2) : 'N/A'
        const writingElapsed = liveTurn?.writingStartedAt
          ? ((now - liveTurn.writingStartedAt) / 1000).toFixed(2)
          : 'N/A'
        console.log(`Session ${sessionId} (store ${i++}):`, {
          liveTurn,
          tokenRate: liveTurn?.tokenRate ?? null,
          outputTokens: liveTurn?.outputTokens ?? undefined,
          phase: liveTurn?.phase ?? null,
          hasTextSegments: liveTurn?.textChunks?.length ?? 0,
          totalChars: liveTurn?.totalChars ?? 0,
          elapsed: `${elapsed}s`,
          writingElapsed: `${writingElapsed}s`,
        })
      }
    }
    console.groupEnd()
  }

  /** Debug helper: dump the ordered message log the client holds for a
   *  session (seq window + ordered render log). This is the authoritative
   *  client-side view — what MessageList renders from.
   *  Usage in DevTools console:
   *    __crwDumpMessages('7a7a1959-...')           // returns an array
   *    __crwDumpMessages('7a7a1959-...', true)     // also console.log a summary
   *  With no arg, dumps every active session. */
  ;(window as unknown as { __crwDumpMessages?: (sessionId?: string, print?: boolean) => unknown }).__crwDumpMessages =
    (sessionId?: string, print?: boolean) => {
      const dumpOne = (sid: string, stores: Set<SessionStore>) => {
        const store = stores.values().next().value
        if (!store) return null
        const messages = store.getState().mirror.messages
        if (print) {
          console.group(`🔍 Messages for ${sid} (${messages.length})`)
          messages.forEach((m, i) => {
            const c = m.message?.content
            let desc = ''
            if (typeof c === 'string') desc = c.slice(0, 80).replace(/\n/g, ' ')
            else if (Array.isArray(c)) desc = c.map((b: Record<string, unknown>) => {
              if (b.type === 'text') return 'text:"' + String(b.text ?? '').slice(0, 60).replace(/\n/g, ' ') + '"'
              if (b.type === 'thinking') return '[thinking]'
              if (b.type === 'tool_use') return '[tool_use:' + b.name + ']'
              if (b.type === 'tool_result') return '[tool_result:' + (b.is_error ? 'err' : 'ok') + ']'
              return '[' + b.type + ']'
            }).join(' ')
            console.log(
              String(i + 1).padStart(3),
              'type=' + (m.type as string).padEnd(12),
              'parent=' + (m.parent_tool_use_id == null ? 'null' : String(m.parent_tool_use_id).slice(0, 6)),
              'isMeta=' + (m.isMeta ? 'T' : 'F'),
              'replay=' + (m.isReplay ? 'T' : 'F'),
              'uuid=' + String(m.uuid ?? '-').slice(0, 8),
              desc,
            )
          })
          console.groupEnd()
        }
        return { sessionId: sid, count: messages.length, messages }
      }
      if (sessionId) {
        const stores = debugStores.get(sessionId)
        return stores ? dumpOne(sessionId, stores) : null
      }
      const all: unknown[] = []
      for (const [sid, stores] of debugStores) all.push(dumpOne(sid, stores))
      return all
    }
}
}
