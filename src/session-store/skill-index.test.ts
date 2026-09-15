// Skill index — the record that makes a FORKED skill's sidechain reachable.
//
// The frame shapes below are not invented: they mirror a real `code-review`
// invocation captured off the app's own WebSocket replay. In that session the
// Skill tool_use sat on the main thread (`parent_tool_use_id: null`) and 64
// frames — 13 Bash, 10 Read and 9 nested Agent launches plus their results —
// arrived carrying `parent_tool_use_id = <the Skill's tool_use id>`. The main
// transcript renders root frames only, so before this index existed every one
// of those frames was dropped with nothing naming their owner.
//
// The two shapes a Skill call can take are both covered, because the card
// branches on which one it is:
//   - context-only (the common case): SKILL.md is loaded into the current
//     conversation, no sidechain, `childCalls` stays empty, no drill-in.
//   - forked: the CLI runs the skill as its own agent and returns a report.

import { describe, expect, it } from 'vitest'
import { rebuildIndexesFromMessages, reduceSessionState } from './reducer'
import { createInitialSessionState, type SessionState } from './types'
import { getSkillStarts, splitSkillName } from './normalize'
import type { Block, SdkMessage } from '../types'

const SKILL_ID = 'call_00_jTaOkdFliXmvbWTo9Nec8918'

function assistant(blocks: Block[], uuid: string, parentToolUseId: string | null = null): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: parentToolUseId,
    receivedAt: 1_000,
    message: { role: 'assistant', content: blocks },
  } as unknown as SdkMessage
}

function user(blocks: Block[], uuid: string, parentToolUseId: string | null = null): SdkMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: parentToolUseId,
    receivedAt: 2_000,
    message: { role: 'user', content: blocks },
  } as unknown as SdkMessage
}

function toolUse(name: string, id: string, input: Record<string, unknown> = {}): Block {
  return { type: 'tool_use', id, name, input } as unknown as Block
}

function toolResult(toolUseId: string, opts: { isError?: boolean; content?: unknown } = {}): Block {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: opts.content ?? 'ok',
    ...(opts.isError ? { is_error: true } : {}),
  } as unknown as Block
}

const resultFrame = (uuid: string): SdkMessage =>
  ({ type: 'result', subtype: 'success', uuid, receivedAt: 3_000 }) as unknown as SdkMessage

function apply(state: SessionState, ...messages: SdkMessage[]): SessionState {
  return messages.reduce(
    (acc, message) => reduceSessionState(acc, { type: 'MESSAGE', message }),
    state,
  )
}

/** The Skill tool_use as it lands on the calling thread. */
const skillCall = (args?: string) =>
  assistant(
    [toolUse('Skill', SKILL_ID, { skill: 'code-review', ...(args ? { args } : {}) })],
    'a-skill',
  )

// ---------------------------------------------------------------------------
// splitSkillName / getSkillStarts
// ---------------------------------------------------------------------------

describe('splitSkillName', () => {
  it('splits a plugin-qualified name on the first colon', () => {
    expect(splitSkillName('superpowers:writing-plans')).toEqual({
      namespace: 'superpowers',
      name: 'writing-plans',
    })
  })

  it('leaves a bare name unqualified', () => {
    expect(splitSkillName('code-review')).toEqual({ namespace: '', name: 'code-review' })
  })

  it('keeps later colons in the name', () => {
    expect(splitSkillName('a:b:c')).toEqual({ namespace: 'a', name: 'b:c' })
  })

  it('treats a leading colon as part of the name (no empty namespace chip)', () => {
    expect(splitSkillName(':odd')).toEqual({ namespace: '', name: ':odd' })
  })
})

describe('getSkillStarts', () => {
  it('reads skill + args and splits the namespace', () => {
    const starts = getSkillStarts(
      assistant([toolUse('Skill', 't1', { skill: 'superpowers:brainstorming', args: ' idea ' })], 'a'),
    )
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      toolUseId: 't1',
      rawName: 'superpowers:brainstorming',
      namespace: 'superpowers',
      name: 'brainstorming',
      args: 'idea',
      status: 'running',
      childCalls: [],
    })
  })

  it('omits args entirely when blank, so the card renders no args line', () => {
    const starts = getSkillStarts(assistant([toolUse('Skill', 't1', { skill: 'x', args: '   ' })], 'a'))
    expect(starts[0]).not.toHaveProperty('args')
  })

  it('falls back to input.name (the SDK has drifted on this field)', () => {
    expect(getSkillStarts(assistant([toolUse('Skill', 't1', { name: 'x' })], 'a'))[0]?.rawName).toBe('x')
  })

  it('skips a block with no usable skill name', () => {
    expect(getSkillStarts(assistant([toolUse('Skill', 't1', {})], 'a'))).toEqual([])
  })

  it('indexes a Skill called from inside a sidechain — a nested fork owns its own', () => {
    const starts = getSkillStarts(
      assistant([toolUse('Skill', 't-inner', { skill: 'x' })], 'a', 'tu_outer'),
    )
    expect(starts).toHaveLength(1)
  })

  it('ignores non-Skill tools and non-assistant frames', () => {
    expect(getSkillStarts(assistant([toolUse('Bash', 't1', { command: 'ls' })], 'a'))).toEqual([])
    expect(getSkillStarts(user([toolResult('t1')], 'u'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Context-only skill — the common case must stay inert
// ---------------------------------------------------------------------------

describe('context-only Skill call', () => {
  it('records the call with no child calls, so the card offers no drill-in', () => {
    const state = apply(createInitialSessionState('s1'), skillCall('high'))
    const record = state.mirror.activeSkills.get(SKILL_ID)
    expect(record).toMatchObject({
      name: 'code-review',
      namespace: '',
      args: 'high',
      status: 'running',
      startedAt: 1_000,
    })
    expect(record?.childCalls).toEqual([])
  })

  it('settles on its own tool_result', () => {
    const state = apply(
      createInitialSessionState('s1'),
      skillCall(),
      user([toolResult(SKILL_ID, { content: 'loaded' })], 'u-skill'),
    )
    const record = state.mirror.activeSkills.get(SKILL_ID)
    expect(record?.status).toBe('done')
    expect(record?.endedAt).toBe(2_000)
    expect(record?.result).toEqual({ content: 'loaded', isError: false })
  })

  it('an errored result settles as interrupted, not done', () => {
    const state = apply(
      createInitialSessionState('s1'),
      skillCall(),
      user([toolResult(SKILL_ID, { isError: true, content: 'no such skill' })], 'u-skill'),
    )
    expect(state.mirror.activeSkills.get(SKILL_ID)?.status).toBe('interrupted')
  })
})

// ---------------------------------------------------------------------------
// Forked skill — the case the whole index exists for
// ---------------------------------------------------------------------------

describe('forked Skill call', () => {
  /** The verified shape: root Skill call, then sidechain frames parented to it. */
  const forkFrames: SdkMessage[] = [
    skillCall('src/styles/utilities.css'),
    // The fork runs its own tools.
    assistant([toolUse('Bash', 'call_00_bash', { command: 'git diff' })], 'a-c1', SKILL_ID),
    user([toolResult('call_00_bash', { content: 'diff…' })], 'u-c1', SKILL_ID),
    // …and launches subagents. Two of the nine from the captured session.
    assistant(
      [
        toolUse('Agent', 'call_00_ILjh', { description: 'Efficiency angle', prompt: 'review…' }),
        toolUse('Agent', 'call_01_wEOs', { description: 'Altitude + Conventions angles' }),
      ],
      'a-c2',
      SKILL_ID,
    ),
  ]

  it('indexes the fork tool calls under the Skill id', () => {
    const state = apply(createInitialSessionState('s1'), ...forkFrames)
    const record = state.mirror.activeSkills.get(SKILL_ID)
    expect(record?.childCalls.map((c) => [c.toolName, c.status])).toEqual([
      ['Bash', 'success'],
      ['Agent', 'running'],
      ['Agent', 'running'],
    ])
    expect(record?.childCalls[0]?.result).toEqual({ content: 'diff…', isError: false })
  })

  it('keeps the nested Agents in the subagent index, so they stay drillable', () => {
    // This is what makes the drill-in worth having: inside the overlay each
    // Agent renders as a SubagentCard reading these records.
    const state = apply(createInitialSessionState('s1'), ...forkFrames)
    expect(state.mirror.activeSubagents.get('call_00_ILjh')?.label).toBe('Efficiency angle')
    expect(state.mirror.activeSubagents.get('call_01_wEOs')?.label).toBe('Altitude + Conventions angles')
  })

  it('settles still-running child rows when the skill reports back', () => {
    const state = apply(
      createInitialSessionState('s1'),
      ...forkFrames,
      user([toolResult(SKILL_ID, { content: 'Skill "code-review" completed (forked execution).' })], 'u-skill'),
    )
    const record = state.mirror.activeSkills.get(SKILL_ID)
    expect(record?.status).toBe('done')
    // The two Agent rows never got a result — the fork is over, so they must
    // not keep spinning inside a finished card.
    expect(record?.childCalls.map((c) => c.status)).toEqual(['success', 'error', 'error'])
  })

  it('does not reopen a settled record when a late sidechain frame arrives', () => {
    const settled = apply(
      createInitialSessionState('s1'),
      skillCall(),
      user([toolResult(SKILL_ID)], 'u-skill'),
    )
    const after = apply(settled, assistant([toolUse('Bash', 'late', { command: 'ls' })], 'a-late', SKILL_ID))
    const record = after.mirror.activeSkills.get(SKILL_ID)
    expect(record?.status).toBe('done')
    expect(record?.childCalls).toEqual([])
  })

  it('rebuilds identically from cached messages (replay / page refresh)', () => {
    const live = apply(createInitialSessionState('s1'), ...forkFrames)
    const rebuilt = rebuildIndexesFromMessages(createInitialSessionState('s1'), forkFrames)
    expect(rebuilt.mirror.activeSkills.get(SKILL_ID)).toEqual(live.mirror.activeSkills.get(SKILL_ID))
  })

  it('turn end sweeps a skill left running, children included', () => {
    const state = apply(createInitialSessionState('s1'), ...forkFrames, resultFrame('r-1'))
    const record = state.mirror.activeSkills.get(SKILL_ID)
    expect(record?.status).toBe('interrupted')
    expect(record?.childCalls.map((c) => c.status)).toEqual(['success', 'error', 'error'])
  })

  it('turn end leaves a settled skill alone (no Map churn)', () => {
    const settled = apply(
      createInitialSessionState('s1'),
      skillCall(),
      user([toolResult(SKILL_ID)], 'u-skill'),
    )
    const after = apply(settled, resultFrame('r-1'))
    expect(after.mirror.activeSkills).toBe(settled.mirror.activeSkills)
  })
})
