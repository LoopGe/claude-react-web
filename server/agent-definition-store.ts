import { promises as fs } from 'node:fs'
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import {
  LEGACY_INVALID_PERMISSION_MODE,
  isSdkAgentPermissionMode,
} from '../shared/agent-definitions.js'
import { JsonFileStore, DEFAULT_DIR_NAME } from './json-file-store.js'
import type { JsonFileStoreOptions } from './json-file-store.js'
import { createLogger } from './log.js'

const log = createLogger('agent-definitions')

/** Fields that make up an SDK AgentDefinition, in Options.agents payload shape. */
export const AGENT_FIELDS = [
  'description', 'prompt', 'tools', 'disallowedTools', 'model', 'mcpServers',
  'skills', 'memory', 'effort', 'permissionMode', 'maxTurns', 'background',
  'initialPrompt', 'observer', 'observerMessage', 'criticalSystemReminder_EXPERIMENTAL',
] as const

export type AgentField = (typeof AGENT_FIELDS)[number]

/** A stored definition: the SDK AgentDefinition plus app bookkeeping. */
export interface StoredAgentDefinition extends AgentDefinition {
  name: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export type AgentDefinitionStoreOptions = JsonFileStoreOptions

/** Persist/CRUD store for custom agent definitions. */
export class AgentDefinitionStore extends JsonFileStore<StoredAgentDefinition> {
  constructor(opts: AgentDefinitionStoreOptions = {}) {
    super(opts, 'agent-definitions.json', DEFAULT_DIR_NAME, 'agent-definitions')
  }
  protected getKey(def: StoredAgentDefinition): string {
    return def.name
  }
  protected parseItems(raw: string): StoredAgentDefinition[] {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) { log.warn(`${this.file} is not an array; ignoring`); return [] }
    const entries: StoredAgentDefinition[] = []
    for (const value of parsed) {
      const def = coerceStoredAgentDefinition(value)
      if (def) entries.push(def)
    }
    return entries
  }
  protected serializeForWrite(items: StoredAgentDefinition[]): unknown {
    return items
  }
  async load(): Promise<StoredAgentDefinition[]> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      this.initEntries(this.parseItems(raw))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.error(`load failed: ${(err as Error).message}`)
      }
    }
    return this.list()
  }
  /** Enabled definitions in SDK `Options.agents` shape (bookkeeping stripped). */
  getEnabledDefinitions(): Record<string, AgentDefinition> {
    const out: Record<string, AgentDefinition> = {}
    for (const def of this.list()) {
      if (!def.enabled) continue
      const { name: _n, enabled: _e, createdAt: _c, updatedAt: _u, ...rest } = def
      out[def.name] = rest as AgentDefinition
    }
    return out
  }
}

const STRING_OPTIONAL: readonly string[] = ['model', 'initialPrompt', 'observer', 'observerMessage', 'criticalSystemReminder_EXPERIMENTAL']
const STRING_ARRAY_OPTIONAL: readonly string[] = ['tools', 'disallowedTools', 'mcpServers', 'skills']
const MEMORY_VALUES = ['user', 'project', 'local']
const EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max']

/** App bookkeeping keys that ride alongside AGENT_FIELDS on a stored def. */
const BOOKKEEPING_FIELDS = ['name', 'enabled', 'createdAt', 'updatedAt'] as const
const KNOWN_KEYS = new Set<string>([...BOOKKEEPING_FIELDS, ...AGENT_FIELDS])

/** Defensive parse of one stored definition; structurally malformed → null
 *  (dropped). Illegal *values* on optional enum fields are STRIPPED rather
 *  than rejecting the whole agent — dropping the entry here used to silently
 *  delete the agent from disk the next time the store rewrote its file (load
 *  filters it out of memory, then any later upsert serializes the in-memory
 *  list only). Write edges that want a hard 400 must validate those fields
 *  separately — see `agent-definition-routes.ts`.
 *
 *  Unknown keys are dropped so hand-edited / client-injected fields cannot
 *  round-trip through disk (AGENT_FIELDS + bookkeeping is the closed set). */
export function coerceStoredAgentDefinition(raw: unknown): StoredAgentDefinition | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const d = raw as Record<string, unknown>
  if (typeof d.name !== 'string' || !d.name.trim()) return null
  if (typeof d.description !== 'string' || !d.description.trim()) return null
  if (typeof d.prompt !== 'string' || !d.prompt.trim()) return null
  if (typeof d.enabled !== 'boolean') return null
  if (typeof d.createdAt !== 'number' || typeof d.updatedAt !== 'number') return null

  // Closed field set — never mutate the caller's object.
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d)) {
    if (KNOWN_KEYS.has(k)) out[k] = v
  }
  const name = out.name as string
  const strip = (field: string, why: string) => {
    log.warn(`agent "${name}": dropping invalid ${field} ${JSON.stringify(out[field])} — ${why}`)
    delete out[field]
  }

  for (const s of STRING_OPTIONAL) {
    if (out[s] !== undefined && (typeof out[s] !== 'string' || !(out[s] as string).trim())) return null
  }
  for (const a of STRING_ARRAY_OPTIONAL) {
    if (out[a] === undefined) continue
    if (!Array.isArray(out[a]) || (out[a] as unknown[]).some((v) => typeof v !== 'string' || !v.trim())) return null
  }
  if (out.memory !== undefined && !MEMORY_VALUES.includes(out.memory as string)) {
    strip('memory', `must be one of ${MEMORY_VALUES.join(', ')}`)
  }
  const effort = out.effort
  if (effort !== undefined) {
    const ok =
      typeof effort === 'number'
        ? Number.isFinite(effort)
        : typeof effort === 'string' && EFFORT_VALUES.includes(effort)
    if (!ok) strip('effort', `must be a finite number or one of ${EFFORT_VALUES.join(', ')}`)
  }
  const pm = out.permissionMode
  if (pm !== undefined && !isSdkAgentPermissionMode(pm)) {
    if (pm === LEGACY_INVALID_PERMISSION_MODE) {
      // Historical UI offered a fake 'disabled' permission mode. Users who
      // picked it meant the agent should not run — preserve that intent by
      // turning the agent off rather than silently enabling it with the
      // session default mode.
      log.warn(
        `agent "${name}": legacy permissionMode 'disabled' was never an SDK mode — ` +
          `disabling the agent (enabled: false) to preserve inert intent; re-enable and pick a real mode if you want it to run`,
      )
      delete out.permissionMode
      out.enabled = false
    } else {
      strip('permissionMode', 'must be an SDK PermissionMode')
    }
  }
  if (out.maxTurns !== undefined && (typeof out.maxTurns !== 'number' || !Number.isFinite(out.maxTurns))) {
    strip('maxTurns', 'must be a finite number')
  }
  if (out.background !== undefined && typeof out.background !== 'boolean') {
    strip('background', 'must be a boolean')
  }
  return out as unknown as StoredAgentDefinition
}
