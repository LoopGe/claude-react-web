// The Skill card's forked-execution drill-in.
//
// The row exists because a forked skill is a sidechain parent: the CLI runs the
// skill as its own agent and the fork's inner frames reach the client parented
// to this tool_use id, where the main transcript (root frames only) drops them.
// The gate matters as much as the row — a context-only Skill call has no
// sidechain, and offering a drill-in into nothing would be a lie.

import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SkillToolView } from './SkillToolView'
import { SkillProvider, skillRecordAsSubagent, type SkillContextValue } from '../../hooks/useSkillContext'
import type { SkillRecord, SubagentChildCall } from '../../session-store/types'

afterEach(cleanup)

const SKILL_ID = 'tu_skill'

const child = (toolName: string, toolUseId: string): SubagentChildCall => ({
  toolUseId,
  toolName,
  argSummary: '',
  status: 'success',
})

const record = (over: Partial<SkillRecord> = {}): SkillRecord => ({
  toolUseId: SKILL_ID,
  rawName: 'code-review',
  name: 'code-review',
  namespace: '',
  status: 'running',
  childCalls: [],
  ...over,
})

function renderView(rec: SkillRecord | null, input: Record<string, unknown> = { skill: 'code-review' }) {
  const open = vi.fn()
  const ctx: SkillContextValue = {
    index: rec ? new Map([[rec.toolUseId, rec]]) : new Map(),
    open,
  }
  render(
    <SkillProvider value={ctx}>
      <SkillToolView input={input} toolUseId={SKILL_ID} />
    </SkillProvider>,
  )
  return { open }
}

describe('SkillToolView', () => {
  it('renders name + namespace chip + args without a drill-in for a context-only call', () => {
    renderView(record({ namespace: 'superpowers', name: 'brainstorming', rawName: 'superpowers:brainstorming', args: 'idea' }))
    expect(screen.getByText('brainstorming')).toBeTruthy()
    expect(screen.getByText('superpowers')).toBeTruthy()
    expect(screen.getByText('idea')).toBeTruthy()
    expect(screen.queryByText('forked execution')).toBeNull()
  })

  it('renders no drill-in when no record exists yet (frame ahead of its record)', () => {
    renderView(null)
    expect(screen.getByText('code-review')).toBeTruthy()
    expect(screen.queryByText('forked execution')).toBeNull()
  })

  it('offers the drill-in once the fork has child calls, counting agents separately', () => {
    renderView(record({
      childCalls: [
        child('Bash', 'c1'),
        child('Read', 'c2'),
        child('Agent', 'c3'),
        child('Agent', 'c4'),
      ],
    }))
    expect(screen.getByText('forked execution')).toBeTruthy()
    expect(screen.getByText('4 calls · 2 agents')).toBeTruthy()
  })

  it('drops the agent clause when the fork ran no subagents', () => {
    renderView(record({ childCalls: [child('Bash', 'c1')] }))
    expect(screen.getByText('1 call')).toBeTruthy()
  })

  it('opens the drill-in for its own tool_use id', () => {
    const { open } = renderView(record({ childCalls: [child('Agent', 'c1')] }))
    fireEvent.click(screen.getByText('forked execution'))
    expect(open).toHaveBeenCalledWith(SKILL_ID)
  })

  it('falls back to parsing the input when rendered with no provider (exports)', () => {
    render(<SkillToolView input={{ skill: 'superpowers:writing-plans' }} toolUseId={SKILL_ID} />)
    expect(screen.getByText('writing-plans')).toBeTruthy()
    expect(screen.getByText('superpowers')).toBeTruthy()
  })

  it('falls back to raw JSON when the input carries no skill name', () => {
    const { container } = render(<SkillToolView input={{ nonsense: 1 }} toolUseId={SKILL_ID} />)
    expect(container.querySelector('.tool-input')).toBeTruthy()
  })
})

describe('skillRecordAsSubagent', () => {
  it('maps the fields SubagentOverlay reads off its record', () => {
    const rec = record({
      name: 'code-review',
      status: 'done',
      startedAt: 1_000,
      endedAt: 5_000,
      childCalls: [child('Bash', 'c1'), child('Agent', 'c2')],
      result: { content: 'Skill "code-review" completed (forked execution).', isError: false },
    })
    expect(skillRecordAsSubagent(rec)).toEqual({
      toolUseId: SKILL_ID,
      label: 'code-review',
      status: 'done',
      startedAt: 1_000,
      endedAt: 5_000,
      toolCount: 2,
      // Not filler: subagentResultText() returns undefined for an async record,
      // which would drop the fork's final report from the overlay's last row.
      isAsync: false,
      result: { content: 'Skill "code-review" completed (forked execution).', isError: false },
    })
  })
})
