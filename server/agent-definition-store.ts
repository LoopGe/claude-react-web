import { promises as fs } from 'node:fs'
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
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

/** Defensive parse of one stored definition; malformed → null (dropped). */
export function coerceStoredAgentDefinition(raw: unknown): StoredAgentDefinition | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const d = raw as Record<string, unknown>
  if (typeof d.name !== 'string' || !d.name.trim()) return null
  if (typeof d.description !== 'string' || !d.description.trim()) return null
  if (typeof d.prompt !== 'string' || !d.prompt.trim()) return null
  if (typeof d.enabled !== 'boolean') return null
  if (typeof d.createdAt !== 'number' || typeof d.updatedAt !== 'number') return null
  for (const s of STRING_OPTIONAL) if (d[s] !== undefined && (typeof d[s] !== 'string' || !d[s].trim())) return null
  for (const a of STRING_ARRAY_OPTIONAL) {
    if (d[a] === undefined) continue
    if (!Array.isArray(d[a]) || d[a].some((v) => typeof v !== 'string' || !v.trim())) return null
  }
  if (d.memory !== undefined && !MEMORY_VALUES.includes(d.memory as string)) return null
  const effort = d.effort
  if (effort !== undefined && typeof effort !== 'number' && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort as string)) return null
  if (effort !== undefined && typeof effort === 'number' && !Number.isFinite(effort)) return null
  const pm = d.permissionMode
  if (pm !== undefined && !['default', 'acceptEdits', 'bypassPermissions', 'plan', 'disabled'].includes(pm as string)) return null
  if (d.maxTurns !== undefined && (typeof d.maxTurns !== 'number' || !Number.isFinite(d.maxTurns))) return null
  if (d.background !== undefined && typeof d.background !== 'boolean') return null
  return d as unknown as StoredAgentDefinition
}
