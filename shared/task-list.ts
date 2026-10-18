// TaskCreate/TaskUpdate event-stream fold — SHARED between the browser
// (TodoChecklist / TaskMutationView via src/utils/task-events.ts re-exports)
// and the server (tasklist-state.ts deriving the snapshot from the full
// transcript). ONE implementation, not mirrors: the client folds the
// in-memory window, the server folds the whole transcript; both feed
// mergeTaskList. Moved verbatim from src/utils/task-events.ts — see that
// file's header comment for the two tool-family background.
//
// The claude CLI exposes task management through ONE of two mutually-
// exclusive tool families (toggled by CLAUDE_CODE_ENABLE_TASKS):
//   1. TodoWrite (legacy) — whole-list snapshots, NOT handled here.
//   2. TaskCreate/TaskUpdate (claude-code 2.x default) — incremental:
//      the server-assigned `#N` appears only in the create's tool_result
//      text; TaskUpdate mutates by that id, status 'deleted' removes.

import {
  userMessageHasToolResult,
  isTaskNotificationUserMessage,
  type UserFrameShape,
} from './user-frames.js'

export interface TaskState {
  id: string
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  activeForm?: string
  lastTouched: number
  provisional?: boolean
  /** Server-precomputed staleness — snapshot entries only (TasklistState).
   *  undefined on window-folded entries: the client then applies its own
   *  window-relative rule (lastTouched vs lastUserInputIndex). */
  stale?: boolean
  /** True when this window entry is a fold-materialized stub (its create
   *  is outside the window) — the subject is `Task #N` filler, not author-
   *  itative. mergeTaskList heals the subject from the snapshot for these. */
  stub?: boolean
}

export const TASK_CREATE = 'TaskCreate'
export const TASK_UPDATE = 'TaskUpdate'

/** The tool_use id when `block` is a TaskCreate/TaskUpdate call, else null.
 *  Pump-side twin of git-broadcast's mutatingToolUseId: the pump remembers
 *  these ids off assistant frames and fires the tasklist broadcast when the
 *  matching tool_result lands. */
export function taskToolUseId(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null
  const b = block as { type?: unknown; name?: unknown; id?: unknown }
  if (b.type !== 'tool_use') return null
  if (b.name !== TASK_CREATE && b.name !== TASK_UPDATE) return null
  return typeof b.id === 'string' ? b.id : null
}

/** Minimal structural slice the fold reads off a transcript frame. The
 *  server's normalized wire objects and the client's SdkMessage both
 *  satisfy it; callers pass `readonly unknown[]` and we narrow here. */
interface FoldableMessage {
  type?: unknown
  message?: unknown
  parent_tool_use_id?: unknown
}

/** Does this transcript contain ANY Task* event at all?
 *
 *  A deliberate extra pass, run before the fold below. The fold's first
 *  stage indexes every tool_result in the session and calls `resultText` on
 *  each (which joins content-block arrays), and the whole thing is thrown
 *  away when the session turns out to have no Task* events — which is the
 *  common case. MessageList re-derives this on every `items` identity change,
 *  i.e. on every streaming flush, so that wasted work was being paid many times
 *  per second for the whole length of a turn.
 *
 *  This does NOT remove the per-flush walk — the memo still keys on `items`
 *  identity, so the transcript is still traversed once per flush. What it
 *  removes is the constant factor: no `resultText` joins over every
 *  tool_result's content blocks, no Map inserts, no second pass. This probe
 *  reads only assistant tool_use block names.
 *
 *  Must stay exactly in step with the verbs the fold acts on — see the note on
 *  `sawAny` at the end of foldTaskEvents for which drift direction is dangerous
 *  and why nothing else catches it. */
function hasTaskEvents(count: number, msgOf: (i: number) => FoldableMessage): boolean {
  for (let i = 0; i < count; i++) {
    const msg = msgOf(i)
    if (msg.type !== 'assistant') continue
    const content = (msg.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (!block || block.type !== 'tool_use') continue
      if (block.name === TASK_CREATE || block.name === TASK_UPDATE) return true
    }
  }
  return false
}

/** Fold the whole TaskCreate/TaskUpdate stream into a Map keyed by numeric
 *  task id (`#N`).
 *
 *  Unlike TodoWrite (a per-turn full snapshot), Task* state is cumulative
 *  across the session, so we walk the ENTIRE message list in order and
 *  apply every event. The numeric id (`#N`) used by TaskUpdate is assigned
 *  by the server and only appears in TaskCreate's tool_result text, so we
 *  first index tool_results by tool_use_id, then parse `#N` from the
 *  result that matches each create.
 *
 *  Returns the **pre-cleanup** map (no stale-completed removal) — callers
 *  that need the visible checklist list (TodoChecklist) apply their own
 *  cleanup on top. Returns `null` when no Task* events exist, so callers
 *  can fall through to "nothing to show". */
export function buildTaskStateMap(
  messages: readonly unknown[],
): Map<string, TaskState> | null {
  return foldTaskEvents(messages.length, (i) => messages[i] as FoldableMessage)
}

/** Same fold, reading `.msg` out of transcript items directly.
 *
 *  Exists so MessageList does not have to `items.map((it) => it.msg)` on every
 *  render: that allocated a fresh N-element array per streaming flush purely
 *  to hand this function something it only ever iterates. */
export function buildTaskStateMapFromItems(
  items: readonly { msg: unknown }[],
): Map<string, TaskState> | null {
  return foldTaskEvents(items.length, (i) => items[i].msg as FoldableMessage)
}

function foldTaskEvents(
  count: number,
  msgOf: (i: number) => FoldableMessage,
): Map<string, TaskState> | null {
  // 0) Cheap probe first — see hasTaskEvents. Without this, a session with no
  //    Task* events still paid for the full tool_result index below.
  if (!hasTaskEvents(count, msgOf)) return null

  // 1) Index every tool_result's text by the tool_use_id it answers. The
  //    SDK wraps tool_results in `user` messages; content may be a string
  //    or an array of text blocks.
  const resultByToolUseId = new Map<string, string>()
  for (let i = 0; i < count; i++) {
    const msg = msgOf(i)
    const content = (msg.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (!block || block.type !== 'tool_result') continue
      const tuid = block.tool_use_id
      if (typeof tuid !== 'string') continue
      resultByToolUseId.set(tuid, resultText(block.content))
    }
  }

  // 2) Walk assistant tool_use blocks in order, folding create/update into
  //    a Map keyed by numeric id. Map preserves insertion (creation) order.
  //    `idx` is the message index, recorded as each task's lastTouched.
  const tasks = new Map<string, TaskState>()
  let sawAny = false

  for (let idx = 0; idx < count; idx++) {
    const msg = msgOf(idx)
    if (msg.type !== 'assistant') continue
    const content = (msg.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (!block || block.type !== 'tool_use') continue
      const input = (block.input as Record<string, unknown> | undefined) ?? undefined

      if (block.name === TASK_CREATE) {
        sawAny = true
        const toolUseId = typeof block.id === 'string' ? block.id : null
        const resText = toolUseId ? resultByToolUseId.get(toolUseId) : undefined
        const id = resText ? parseTaskId(resText) : null
        // In-flight create whose result hasn't landed yet: we don't know the
        // server id, so synthesize a stable provisional key from the tool_use
        // id. A later TaskUpdate can only reference the real `#N`, so this
        // provisional entry naturally resolves once the result arrives and a
        // subsequent render parses the id.
        const key = id ?? (toolUseId ? `pending:${toolUseId}` : `pending:${tasks.size}`)
        const desc = str(input?.description)
        tasks.set(key, {
          id: id ?? key,
          subject: str(input?.subject) ?? '(no subject)',
          ...(desc !== undefined ? { description: desc } : {}),
          status: normalizeStatus(str(input?.status)) ?? 'pending',
          activeForm: str(input?.activeForm),
          lastTouched: idx,
          provisional: id == null,
        })
        continue
      }

      if (block.name === TASK_UPDATE) {
        sawAny = true
        const id = str(input?.taskId)
        if (!id) continue
        const rawStatus = str(input?.status)
        // 'deleted' removes the task from the list entirely.
        if (rawStatus === 'deleted') {
          tasks.delete(id)
          continue
        }
        const existing = tasks.get(id)
        const next: TaskState = existing ?? {
          // Update for a task created before our history window (or whose
          // create we never saw) — materialize a stub so it still shows.
          id,
          subject: str(input?.subject) ?? `Task #${id}`,
          status: 'pending',
          lastTouched: idx,
          stub: true,
        }
        if (input && 'subject' in input) {
          const s = str(input.subject)
          if (s) next.subject = s
        }
        if (input && 'description' in input) {
          const d = str(input.description)
          // Same rule as subject: a non-empty update overwrites; an update
          // that omits the field (or empties it) keeps the stored value.
          if (d) next.description = d
        }
        if (input && 'activeForm' in input) {
          next.activeForm = str(input.activeForm)
        }
        const ns = normalizeStatus(rawStatus)
        if (ns) next.status = ns
        next.lastTouched = idx
        tasks.set(id, next)
      }
    }
  }

  // `sawAny` is now implied by the stage-0 probe, but it stays as the authority
  // because it is derived from the branches that actually fold.
  //
  // Note which drift direction it can and cannot cover. A probe that is MORE
  // permissive than the fold is harmless — one wasted fold, and `sawAny` still
  // answers "no tasks" here. The dangerous direction is the opposite: a probe
  // that MISSES a verb the fold acts on returns null for a session that really
  // has tasks, and TodoChecklist plus TaskMutationView go blank with no error
  // anywhere. `sawAny` cannot catch that, because the fold never runs. So if a
  // third verb is ever added below, it MUST be added to hasTaskEvents in the
  // same change; the parity test in shared/task-list.test.ts is the reminder.
  if (!sawAny) return null
  return tasks
}

/** Coerce a tool_result `content` field (string | array of text blocks |
 *  other) to a flat string for `#N` parsing. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
          return (b as { text: string }).text
        }
        return ''
      })
      .join(' ')
  }
  return ''
}

/** Pull the server-assigned numeric task id out of a TaskCreate result like
 *  `"Task #3 created successfully: Deploy"`. Returns the id as a string (to
 *  match TaskUpdate's `taskId`), or null when absent. */
export function parseTaskId(text: string): string | null {
  const m = text.match(/#(\d+)/)
  return m ? m[1] : null
}

/** Narrow an unknown to a non-empty string, else undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Map the Task* status vocabulary onto the states we track. 'deleted' is
 *  handled by the caller (removal); everything unknown is dropped (returns
 *  undefined so the caller keeps the previous status). */
export function normalizeStatus(
  s: string | undefined,
): 'pending' | 'in_progress' | 'completed' | 'cancelled' | undefined {
  if (s === 'pending' || s === 'in_progress' || s === 'completed' || s === 'cancelled') return s
  return undefined
}

// --- snapshot payload types ---------------------------------------------

export interface TasklistSnapshotTask {
  /** Server-assigned numeric id (the `#N`), same shape as TaskUpdate's
   *  `taskId` input — the stable identity across snapshot and window fold. */
  id: string
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  activeForm?: string
  /** Server-precomputed staleness (resolved AND last touched before the
   *  last genuine user input). The client executes this flag as-is for
   *  snapshot-only entries; window entries keep their own window-relative
   *  rule — EXCEPT ghost-adopted entries (window unresolved, snapshot
   *  resolved), whose status came from this coordinate system and whose
   *  flag is copied with it. See mergeTaskList. */
  stale: boolean
}

export interface TasklistSnapshotPayload {
  /** Count of Task* tool_use events folded. Monotone under append-only
   *  transcript growth; the client drops frames whose rev regresses. */
  rev: number
  tasks: TasklistSnapshotTask[]
}

/** Count TaskCreate/TaskUpdate tool_use blocks. Monotone under append-only
 *  growth (per session; /clear respawns to a new id). */
export function countTaskEvents(messages: readonly unknown[]): number {
  let n = 0
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as FoldableMessage
    if (msg.type !== 'assistant') continue
    const content = (msg.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (!block || block.type !== 'tool_use') continue
      if (block.name === TASK_CREATE || block.name === TASK_UPDATE) n++
    }
  }
  return n
}

/** Server-side criterion for a genuine top-level HUMAN input frame — the
 *  LIVE-wire discriminator: the pump's echo drop-filter calls this directly
 *  (the echo is droppable exactly when the frame is not a genuine human
 *  input). Covers: null parent, no tool_result block, no
 *  <task-notification> injection — so background-subagent result
 *  injections and tool_result carriers never qualify. Live sidechain
 *  frames carry a non-null parent_tool_use_id, so they are excluded
 *  without an isSidechain check; the DISK form (subagent-transcript lines
 *  carry isSidechain:true but NO parent_tool_use_id — that field exists
 *  only on live wire frames) is excluded separately by the disk fold's
 *  boundary scan in deriveTaskListFromLines. Keeping this predicate free
 *  of isSidechain is deliberate: reusing it for live frames must not
 *  change how frames with the (disk-only) marker are forwarded.
 *  (The client's window cleanup uses the richer isHumanUserMessage;
 *  snapshot entries carry the server's precomputed flag instead, so the
 *  two never compare across coordinate systems.) */
export function isGenuineUserInputFrame(msg: UserFrameShape): boolean {
  if (msg.type !== 'user') return false
  if (msg.parent_tool_use_id != null) return false
  if (userMessageHasToolResult(msg)) return false
  if (isTaskNotificationUserMessage(msg)) return false
  return true
}

/** Visibility cleanup over a merged task map — the ONE filter TodoChecklist
 *  (and the cross-layer regression test) execute: drop resolved tasks whose
 *  staleness predates the last genuine user input (snapshot entries carry
 *  the server-precomputed flag; window entries fall back to their
 *  window-relative `lastTouched < lastUserInputIdx`), and drop stale
 *  provisional orphans (in-flight creates whose turn moved on). Pure. */
export function filterVisibleTasks(
  merged: Map<string, TaskState>,
  lastUserInputIdx: number,
): TaskState[] {
  const out: TaskState[] = []
  for (const t of merged.values()) {
    const resolved = t.status === 'completed' || t.status === 'cancelled'
    const stale = t.stale ?? (t.lastTouched < lastUserInputIdx)
    if (resolved && stale) continue
    if (t.provisional && stale) continue
    out.push(t)
  }
  return out
}

/** Merge the server snapshot (full-history base) under the client's window
 *  fold (freshest event order). Per id: the window's status/provisional
 *  win (freshest events) EXCEPT the ghost case — window unresolved while
 *  the snapshot is resolved adopts the snapshot's completion AND its stale
 *  flag (see the branch below: the completion lives in history the window
 *  never sees). The snapshot also fills ids the window can't see, and
 *  heals the subject of window STUB entries (create outside the window —
 *  the whole reason the snapshot exists). Snapshot-only entries flagged
 *  `stale && resolved` are dropped here — the client's window-relative
 *  staleness rule cannot see them.
 *  Pure; returns a fresh Map. */
export function mergeTaskList(
  snapshot: TasklistSnapshotPayload | null | undefined,
  windowFold: Map<string, TaskState> | null,
): Map<string, TaskState> {
  const merged = new Map<string, TaskState>()
  if (windowFold) {
    for (const [id, t] of windowFold) merged.set(id, { ...t })
  }
  if (snapshot) {
    for (const t of snapshot.tasks) {
      const w = merged.get(t.id)
      if (!w) {
        if (t.stale && (t.status === 'completed' || t.status === 'cancelled')) continue
        merged.set(t.id, {
          id: t.id,
          subject: t.subject,
          ...(t.description !== undefined ? { description: t.description } : {}),
          status: t.status,
          ...(t.activeForm !== undefined ? { activeForm: t.activeForm } : {}),
          // Server line-index coordinate — meaningless client-side; the
          // stale flag supersedes it for snapshot-only entries.
          lastTouched: -1,
          stale: t.stale,
        })
        continue
      }
      // Window entry exists: keep its fresher status — EXCEPT the ghost
      // case: the window is UNRESOLVED while the full-history fold says
      // RESOLVED. A completion can only ever come from the full history
      // (subagent sidechain files the main transcript never carries, or
      // events evicted past the ring cap), so an unresolved window view of
      // a task the snapshot says completed is a stale ghost — the precise
      // mechanism that kept subagent-completed tasks on the checklist
      // forever. The reverse (window resolved, snapshot unresolved) keeps
      // the window: the freshest event order is genuinely the window's
      // there.
      //
      // Known limitation, accepted: between a RE-OPEN and the snapshot
      // re-derive, the snapshot's completed wins over the window's
      // genuinely-fresher in_progress. For MAIN-thread Task tools the
      // re-derive fires on the tool_result landing — sub-second. For a
      // BACKGROUND subagent that re-opens or creates tasks mid-run there
      // is NO derive trigger until its completion notification (its inner
      // frames ride no live frames), so the wrong/hidden state can persist
      // for the agent's remaining runtime; the task_notification trigger
      // heals it at completion. Closing that mid-run gap needs a
      // sidechain-growth trigger in the watcher's poll loop — not worth
      // the surgery while no real case has surfaced.
      if (w.status !== 'completed' && w.status !== 'cancelled'
        && (t.status === 'completed' || t.status === 'cancelled')) {
        w.status = t.status
        // The stale flag rides WITH the adopted status: the status itself
        // now comes from the snapshot's coordinate system, so its
        // precomputed visibility flag is the truth for this entry. Leaving
        // it undefined would fall back to the window-relative rule, which
        // shows the ghost forever once the window has evicted every
        // genuine user input (lastUserInputIndex → -1 → stale=false).
        w.stale = t.stale
      }
      // A stub subject is fold filler (`Task #N`) — the snapshot's subject
      // is the real one. A stub's description is likewise missing/ filler —
      // heal it too (but never overwrite a description the window actually
      // has).
      if (w.stub) {
        w.subject = t.subject
        if (w.description === undefined && t.description !== undefined) w.description = t.description
        if (w.activeForm === undefined && t.activeForm !== undefined) w.activeForm = t.activeForm
      }
    }
  }
  return merged
}