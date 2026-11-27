// server/providers/native/task-store.ts
//
// The native provider's per-session Task* store: the authoritative state behind
// TaskCreate/TaskUpdate (and, later, TaskGet/TaskList). Unlike the host's
// shared/task-list.ts fold — which keeps only the checklist fields the client
// renders — this store retains the FULL record (blocks/blockedBy/owner/metadata)
// so the query tools can answer dependency and ownership questions.
//
// Ids are sequential numeric strings ("1", "2", …), monotone per session. The
// assigned `#N` appears only in TaskCreate's tool_result text, so `rebuild`
// (resume) parses it from the result via the shared parseTaskId — never from the
// create input — and replays every TaskUpdate patch through the SAME `update`
// mutation path the live tool uses, so a rebuilt store equals the live one.
//
// Neutral CORE: imports only neutral shared/* + sibling vocabulary. No SDK, no
// host frame vocabulary (the neutrality pin in vocabulary/neutrality.test.ts
// covers this file).

import { parseTaskId, resultText, TASK_CREATE, TASK_UPDATE } from '../../../shared/task-list.js'
import type { NativeSessionEvent } from './vocabulary/session-event.js'
import { parseToolInput } from './vocabulary/types.js'

export type NativeTaskStatus = 'pending' | 'in_progress' | 'completed'

export interface NativeTaskRecord {
  id: string
  subject: string
  description: string
  status: NativeTaskStatus
  activeForm?: string
  blocks: string[]
  blockedBy: string[]
  owner?: string
  metadata?: Record<string, unknown>
}

export interface TaskCreateInput {
  subject: string
  description: string
  activeForm?: string
  metadata?: Record<string, unknown>
}

/** The TaskUpdate mutation surface (mirrors the CLI TaskUpdateInput).
 *  `status: 'deleted'` removes the record; addBlocks/addBlockedBy merge with
 *  dedup; metadata merges key-by-key (a null value deletes that key). */
export interface TaskUpdatePatch {
  subject?: string
  description?: string
  activeForm?: string
  status?: NativeTaskStatus | 'deleted'
  addBlocks?: string[]
  addBlockedBy?: string[]
  owner?: string
  metadata?: Record<string, unknown>
}

export interface TaskUpdateResult {
  success: boolean
  taskId: string
  /** Record fields the patch applied, in application order. */
  updatedFields: string[]
  statusChange?: { from: string; to: string }
  error?: string
}

export class NativeTaskStore {
  private readonly tasks = new Map<string, NativeTaskRecord>()
  private nextId = 1

  create(input: TaskCreateInput): NativeTaskRecord {
    return this.insert(String(this.nextId++), input)
  }

  get(taskId: string): NativeTaskRecord | null {
    return this.tasks.get(taskId) ?? null
  }

  /** All records in creation order. */
  list(): NativeTaskRecord[] {
    return [...this.tasks.values()]
  }

  update(taskId: string, patch: TaskUpdatePatch): TaskUpdateResult {
    const record = this.tasks.get(taskId)
    if (!record) {
      return { success: false, taskId, updatedFields: [], error: `Task #${taskId} not found` }
    }
    if (patch.status === 'deleted') {
      this.tasks.delete(taskId)
      return { success: true, taskId, updatedFields: ['status'], statusChange: { from: record.status, to: 'deleted' } }
    }

    const updatedFields: string[] = []
    let statusChange: { from: string; to: string } | undefined
    if (patch.subject !== undefined) {
      record.subject = patch.subject
      updatedFields.push('subject')
    }
    if (patch.description !== undefined) {
      record.description = patch.description
      updatedFields.push('description')
    }
    if (patch.activeForm !== undefined) {
      record.activeForm = patch.activeForm
      updatedFields.push('activeForm')
    }
    if (patch.status !== undefined) {
      if (patch.status !== record.status) statusChange = { from: record.status, to: patch.status }
      record.status = patch.status
      updatedFields.push('status')
    }
    if (patch.addBlocks !== undefined) {
      for (const id of patch.addBlocks) if (!record.blocks.includes(id)) record.blocks.push(id)
      updatedFields.push('blocks')
    }
    if (patch.addBlockedBy !== undefined) {
      for (const id of patch.addBlockedBy) if (!record.blockedBy.includes(id)) record.blockedBy.push(id)
      updatedFields.push('blockedBy')
    }
    if (patch.owner !== undefined) {
      record.owner = patch.owner
      updatedFields.push('owner')
    }
    if (patch.metadata !== undefined) {
      const merged = { ...record.metadata }
      for (const [key, value] of Object.entries(patch.metadata)) {
        if (value === null) delete merged[key]
        else merged[key] = value
      }
      record.metadata = merged
      updatedFields.push('metadata')
    }
    return { success: true, taskId, updatedFields, ...(statusChange ? { statusChange } : {}) }
  }

  /** Rebuild the store from a neutral event sequence (resume / fork). Replaces
   *  any prior state. The create id is parsed from the matching tool_result
   *  text; a create whose result never landed (an interrupted turn) assigned no
   *  id, so it — and any update referencing it — folds to nothing. */
  rebuild(events: readonly NativeSessionEvent[]): void {
    this.tasks.clear()
    this.nextId = 1

    // 1) Index every tool result's text by the call id it answers.
    const resultByCallId = new Map<string, string>()
    for (const event of events) {
      if (event.type === 'tool/result') {
        resultByCallId.set(event.data.message.toolCallId, resultText(event.data.message.content))
      }
    }

    // 2) Walk assistant tool-call blocks in log order, folding create/update.
    //    Inputs are the raw JSON the model sent — the same values the live tool
    //    validated and stored verbatim — so replaying them through `update`
    //    reproduces the live record exactly.
    for (const event of events) {
      if (event.type !== 'assistant/message') continue
      for (const block of event.data.message.content) {
        if (block.type !== 'tool-call') continue
        const input = parseToolInput(block.arguments)
        if (block.name === TASK_CREATE) {
          const text = resultByCallId.get(block.id)
          const id = text === undefined ? null : parseTaskId(text)
          if (id === null) continue
          this.insert(id, input as unknown as TaskCreateInput)
          this.nextId = Math.max(this.nextId, Number(id) + 1)
        } else if (block.name === TASK_UPDATE) {
          const taskId = typeof input.taskId === 'string' ? input.taskId : null
          if (taskId === null) continue
          this.update(taskId, input as unknown as TaskUpdatePatch)
        }
      }
    }
  }

  private insert(id: string, input: TaskCreateInput): NativeTaskRecord {
    const record: NativeTaskRecord = {
      id,
      subject: input.subject,
      description: input.description,
      status: 'pending',
      blocks: [],
      blockedBy: [],
    }
    if (input.activeForm !== undefined) record.activeForm = input.activeForm
    if (input.metadata !== undefined) record.metadata = { ...input.metadata }
    this.tasks.set(id, record)
    return record
  }
}