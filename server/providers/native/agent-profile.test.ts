import { describe, expect, it } from 'vitest'
import type { StoredAgentDefinition } from '../../agent-definition-store.js'
import {
  agentSelectionFromEvents,
  assertAgentProfileSupported,
  profileFromDefinition,
  unsupportedAgentFields,
} from './agent-profile.js'
import type { NativeAgentSelectionEvent } from './agent-profile.js'
import { projectNeutralEventToLegacy } from './session-log/format.js'
import type { NativeSessionEvent, SessionEvent } from './vocabulary/session-event.js'

function definition(overrides: Partial<StoredAgentDefinition> = {}): StoredAgentDefinition {
  return {
    name: 'reviewer',
    description: 'Reviews code',
    prompt: 'Review the change carefully.',
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function selection(seq: number, name: string | null): NativeAgentSelectionEvent {
  return {
    seq,
    type: 'session/agent',
    name,
    ...(name === null ? {} : { definition: definition({ name }) }),
    base: {
      model: 'claude-sonnet-4-5',
      permissionMode: 'default',
      effortLevel: 'high',
      skillPolicy: ['code-review'],
      toolProfile: { tools: ['Read', 'Grep'] },
    },
    timestamp: '2026-11-11T00:00:00.000Z',
  }
}

/** The neutral v3 form of the legacy selection fixture above — the durable
 *  language agentSelectionFromEvents reads (option C read-side). */
function neutralSelection(seq: number, name: string | null): SessionEvent<'session/agent'> {
  const legacy = selection(seq, name)
  return {
    seq,
    type: 'session/agent',
    time: Date.parse(legacy.timestamp),
    data: {
      name: legacy.name,
      ...(legacy.definition !== undefined ? { definition: legacy.definition } : {}),
      base: legacy.base,
      timestamp: legacy.timestamp,
    },
  }
}

const compact = (seq: number): NativeSessionEvent => ({
  seq,
  type: 'session/compact',
  time: Date.parse('2026-11-11T00:00:00.000Z'),
  data: {
    text: 'SUMMARY',
    context: 'CONTEXT',
    uuid: `compact-${seq}`,
    timestamp: '2026-11-11T00:00:00.000Z',
  },
})

describe('native agent profiles', () => {
  it('maps every supported definition field and preserves an empty tools allowlist', () => {
    const def = definition({
      model: 'claude-opus-4-1',
      tools: [],
      disallowedTools: ['Bash'],
      mcpServers: ['workspace'],
      skills: ['code-review', 'testing'],
      permissionMode: 'plan',
      maxTurns: 7,
      effort: 'xhigh',
    })

    expect(profileFromDefinition(def)).toEqual({
      name: 'reviewer',
      instruction: 'Review the change carefully.',
      model: 'claude-opus-4-1',
      tools: [],
      disallowedTools: ['Bash'],
      mcpServers: ['workspace'],
      skills: ['code-review', 'testing'],
      permissionMode: 'plan',
      maxTurns: 7,
      effort: 'xhigh',
    })
  })

  it('keeps profile arrays unchanged when source definition arrays mutate', () => {
    const def = definition({
      tools: ['Read'],
      disallowedTools: ['Bash'],
      mcpServers: ['workspace'],
      skills: ['code-review'],
    })
    const profile = profileFromDefinition(def)

    def.tools!.push('Grep')
    def.disallowedTools!.push('Write')
    def.mcpServers!.push('extra-server')
    def.skills!.push('testing')

    expect({
      tools: profile.tools,
      disallowedTools: profile.disallowedTools,
      mcpServers: profile.mcpServers,
      skills: profile.skills,
    }).toEqual({
      tools: ['Read'],
      disallowedTools: ['Bash'],
      mcpServers: ['workspace'],
      skills: ['code-review'],
    })
  })

  it('keeps source definition arrays unchanged when profile arrays mutate', () => {
    const def = definition({
      tools: ['Read'],
      disallowedTools: ['Bash'],
      mcpServers: ['workspace'],
      skills: ['code-review'],
    })
    const profile = profileFromDefinition(def)

    profile.tools!.push('Glob')
    profile.disallowedTools!.push('Edit')
    profile.mcpServers!.push('profile-server')
    profile.skills!.push('profile-skill')

    expect({
      tools: def.tools,
      disallowedTools: def.disallowedTools,
      mcpServers: def.mcpServers,
      skills: def.skills,
    }).toEqual({
      tools: ['Read'],
      disallowedTools: ['Bash'],
      mcpServers: ['workspace'],
      skills: ['code-review'],
    })
  })

  it('lists every unsupported field and numeric effort by name', () => {
    const def = definition({
      background: true,
      initialPrompt: 'Start now',
      memory: 'project',
      observer: 'watcher',
      observerMessage: 'Observe this run',
      criticalSystemReminder_EXPERIMENTAL: 'Be careful',
      omitClaudeMd: true,
      effort: 4096,
    })
    const fields = [
      'background',
      'initialPrompt',
      'memory',
      'observer',
      'observerMessage',
      'criticalSystemReminder_EXPERIMENTAL',
      'omitClaudeMd',
      'effort',
    ]

    expect(unsupportedAgentFields(def)).toEqual(fields)

    let thrown: unknown
    try {
      assertAgentProfileSupported(def)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    for (const field of fields) {
      expect((thrown as Error).message).toContain(field)
    }
  })

  it('accepts a definition using only supported fields', () => {
    const def = definition({ effort: 'max', tools: [], background: undefined })
    expect(unsupportedAgentFields(def)).toEqual([])
    expect(() => assertAgentProfileSupported(def)).not.toThrow()
  })
})

describe('agentSelectionFromEvents (neutral read)', () => {
  it('returns the last selection as the legacy snapshot shape and undefined when none exists', () => {
    const first = neutralSelection(0, 'reviewer')
    const last = neutralSelection(2, null)
    expect(agentSelectionFromEvents([first, compact(1), last])).toEqual(selection(2, null))
    expect(agentSelectionFromEvents([compact(0)])).toBeUndefined()
    expect(agentSelectionFromEvents([])).toBeUndefined()
  })

  it('does not treat compact as a floor for selection state', () => {
    const selected = neutralSelection(0, 'reviewer')
    expect(agentSelectionFromEvents([selected, compact(1)])).toEqual(selection(0, 'reviewer'))
  })

  it('maps the neutral selection to exactly the legacy read-view event (behavior pin)', () => {
    const events: NativeSessionEvent[] = [
      compact(0),
      neutralSelection(1, 'reviewer'),
      neutralSelection(2, null),
    ]
    // The legacy read the old scan performed: the log's legacy projection,
    // last top-level 'session/agent' event returned verbatim.
    const legacyView = events.map((event) => projectNeutralEventToLegacy(event, 's'))
    const legacySelection = [...legacyView].reverse().find((event) => event.type === 'session/agent')
    expect(agentSelectionFromEvents(events)).toEqual(legacySelection)
  })

  it('carries a dropped-agent refusal through the neutral data payload', () => {
    const dropped: SessionEvent<'session/agent'> = {
      seq: 0,
      type: 'session/agent',
      time: Date.parse('2026-11-11T00:00:00.000Z'),
      data: {
        name: null,
        droppedAgent: { name: 'reviewer', unsupportedFields: ['background', 'memory'] },
        base: { model: 'claude-sonnet-4-5', permissionMode: 'default' },
        timestamp: '2026-11-11T00:00:00.000Z',
      },
    }
    expect(agentSelectionFromEvents([dropped])).toEqual({
      seq: 0,
      type: 'session/agent',
      name: null,
      droppedAgent: { name: 'reviewer', unsupportedFields: ['background', 'memory'] },
      base: { model: 'claude-sonnet-4-5', permissionMode: 'default' },
      timestamp: '2026-11-11T00:00:00.000Z',
    })
  })
})
