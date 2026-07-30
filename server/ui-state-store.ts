// Persists UI layout state (session groups, sidebar order, collapsed groups)
// to a single JSON file on disk. This data was previously stored in
// localStorage only, meaning it was lost on browser switch / device change.
//
// Single-document pattern: the entire state is read as a unit on load and
// written as a unit on every update (debounced). We do NOT extend
// JsonFileStore because there is no keyed collection — just one blob.

import { readFile } from 'node:fs/promises'
import { join as joinPath } from 'node:path'
import { homedir } from 'node:os'
import { writeAtomic } from './json-file-store.js'
import { createLogger } from './log.js'

const log = createLogger('ui-state')

const DEFAULT_DIR_NAME = '.claude-react-web'
const FILE_NAME = 'ui-state.json'
const DEBOUNCE_MS = 500

/** Shape of a session group — mirrors the frontend SessionGroup interface. */
export interface StoredSessionGroup {
  id: string
  name: string
  sessionIds: string[]
  panelRatios?: Record<string, number>
}

export interface UiState {
  groups: StoredSessionGroup[]
  sidebarOrder: string[]
  collapsedGroups: Record<string, boolean>
}

const EMPTY_STATE: UiState = {
  groups: [],
  sidebarOrder: [],
  collapsedGroups: {},
}

function coerceUiState(raw: unknown): UiState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_STATE }
  const obj = raw as Record<string, unknown>
  const groups: StoredSessionGroup[] = []
  if (Array.isArray(obj.groups)) {
    for (const g of obj.groups) {
      if (g && typeof g === 'object' && !Array.isArray(g)) {
        const go = g as Record<string, unknown>
        if (typeof go.id === 'string' && typeof go.name === 'string' && Array.isArray(go.sessionIds)) {
          const sessionIds = go.sessionIds.filter((s): s is string => typeof s === 'string')
          const entry: StoredSessionGroup = { id: go.id, name: go.name, sessionIds }
          if (go.panelRatios && typeof go.panelRatios === 'object' && !Array.isArray(go.panelRatios)) {
            entry.panelRatios = go.panelRatios as Record<string, number>
          }
          groups.push(entry)
        }
      }
    }
  }
  const sidebarOrder = Array.isArray(obj.sidebarOrder)
    ? obj.sidebarOrder.filter((s): s is string => typeof s === 'string')
    : []
  const collapsedGroups: Record<string, boolean> = {}
  if (obj.collapsedGroups && typeof obj.collapsedGroups === 'object' && !Array.isArray(obj.collapsedGroups)) {
    for (const [k, v] of Object.entries(obj.collapsedGroups as Record<string, unknown>)) {
      if (typeof k === 'string') collapsedGroups[k] = !!v
    }
  }
  return { groups, sidebarOrder, collapsedGroups }
}

export class UiStateStore {
  private readonly file: string
  private readonly dir: string
  private state: UiState = { ...EMPTY_STATE }
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(opts: { stateDir?: string } = {}) {
    this.dir = opts.stateDir ?? joinPath(homedir(), DEFAULT_DIR_NAME)
    this.file = joinPath(this.dir, FILE_NAME)
  }

  /** Load state from disk. Missing or corrupt file → empty state. */
  async load(): Promise<UiState> {
    try {
      const raw = await readFile(this.file, 'utf8')
      this.state = coerceUiState(JSON.parse(raw))
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') {
        log.warn(`failed to read ${this.file}: ${e.message}`)
      }
      this.state = { ...EMPTY_STATE }
    }
    return this.state
  }

  /** Return the current in-memory snapshot. */
  getState(): UiState {
    return this.state
  }

  /** Reset to the empty state and flush to disk. */
  async clearAll(): Promise<void> {
    this.state = { ...EMPTY_STATE }
    this.dirty = true
    await this.flush()
  }

  /** Merge a partial update into the in-memory state and schedule a
   *  debounced flush. Callers use functional updaters on the frontend;
   *  the backend receives the full merged object. */
  update(next: UiState): void {
    this.state = next
    this.schedule()
  }

  /** One-time import from legacy localStorage data. Only writes if the
   *  file does not already exist or is unreadable (idempotent guard).
   *  Returns true if the import was applied, false if skipped (file
   *  already exists and is readable). */
  async importFromLegacy(data: UiState): Promise<boolean> {
    try {
      await readFile(this.file, 'utf8')
      // File exists and is readable — do not overwrite.
      return false
    } catch {
      // File does not exist or is unreadable — write the imported data.
      this.state = coerceUiState(data)
      await this.flush()
      log.info('imported legacy localStorage state')
      return true
    }
  }

  /** Immediate write. Awaitable for shutdown. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty && !this.writing) return
    const snapshot = this.state
    this.dirty = false
    this.writing = this.writing
      .then(() => writeAtomic(this.dir, this.file, snapshot))
      .catch((err) => {
        this.dirty = true
        log.error(`write failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    await this.writing
    if (this.dirty && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.flush()
      }, DEBOUNCE_MS)
      this.timer.unref?.()
    }
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, DEBOUNCE_MS)
    this.timer.unref?.()
  }
}
