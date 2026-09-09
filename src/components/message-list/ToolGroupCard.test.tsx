import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { useState } from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { ToolGroupCard } from './ToolGroupCard'
import { ToolStatusProvider, ToolResultProvider, PlanStatusProvider } from '../../hooks/usePlanStatus'
import { QuestionAnswersProvider } from '../../hooks/useQuestionAnswers'
import { BackgroundToolProvider } from '../../hooks/useBackgroundTool'
import type { ToolStatus } from '../../session-store/types'
import type { SdkMessage } from '../../types'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function toolMsg(id: string, name = 'Read', input: Record<string, unknown> = {}): SdkMessage {
  return {
    type: 'assistant',
    uuid: id,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `${id}-tu`, name, input }],
    },
  } as unknown as SdkMessage
}

function renderGroup({
  members,
  toolStatus,
  planStatus = new Map(),
  questionAnswers = new Map(),
  searchQuery,
  activeMemberItemIndex,
  activeMatchInItem,
  working,
}: {
  members: SdkMessage[]
  toolStatus: Map<string, ToolStatus>
  planStatus?: Map<string, 'approved' | 'rejected' | 'pending'>
  questionAnswers?: Map<string, unknown[]>
  searchQuery?: string
  activeMemberItemIndex?: number
  activeMatchInItem?: number
  working?: boolean
}) {
  return render(
    <ToolStatusProvider value={toolStatus}>
      <ToolResultProvider value={new Map()}>
        <PlanStatusProvider value={planStatus}>
          <QuestionAnswersProvider value={questionAnswers as never}>
            <BackgroundToolProvider value={undefined}>
              <ToolGroupCard
                members={members}
                memberItemIndices={members.map((_, i) => i)}
                searchQuery={searchQuery}
                activeMemberItemIndex={activeMemberItemIndex}
                activeMatchInItem={activeMatchInItem}
                working={working}
              />
            </BackgroundToolProvider>
          </QuestionAnswersProvider>
        </PlanStatusProvider>
      </ToolResultProvider>
    </ToolStatusProvider>,
  )
}

function isOpen(container: HTMLElement): boolean {
  return container.querySelector('.tool-group-card')!.getAttribute('data-state') === 'open'
}

describe('ToolGroupCard', () => {
  it('defaults collapsed when every tool settled successfully', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'success'],
      ]),
    })
    expect(isOpen(container)).toBe(false)
    expect(container.textContent).toContain('Read')
  })

  it('defaults expanded while any tool is still running', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'running'],
      ]),
    })
    expect(isOpen(container)).toBe(true)
    expect(container.querySelector('.tool-status-running')).not.toBeNull()
  })

  it('keeps a running group open even after a manual close', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'running'],
      ]),
    })
    expect(isOpen(container)).toBe(true)
    fireEvent.click(container.querySelector('.tool-group-summary-inner')!)
    // forceOpen (running) wins over userOpen=false
    expect(isOpen(container)).toBe(true)
  })

  it('stays open mid-turn when tools settle between calls, then folds after the turn ends', () => {
    vi.useFakeTimers()
    function Harness() {
      const [status, setStatus] = useState<Map<string, ToolStatus>>(
        new Map([
          ['t1-tu', 'success' as const],
          ['t2-tu', 'running' as const],
        ]),
      )
      const [working, setWorking] = useState(true)
      const members = [toolMsg('t1'), toolMsg('t2')]
      return (
        <>
          <button
            type="button"
            data-testid="settle"
            onClick={() =>
              setStatus(
                new Map([
                  ['t1-tu', 'success' as const],
                  ['t2-tu', 'success' as const],
                ]),
              )
            }
          />
          <button type="button" data-testid="turn-end" onClick={() => setWorking(false)} />
          <ToolStatusProvider value={status}>
            <ToolResultProvider value={new Map()}>
              <PlanStatusProvider value={new Map()}>
                <QuestionAnswersProvider value={new Map() as never}>
                  <BackgroundToolProvider value={undefined}>
                    <ToolGroupCard
                      members={members}
                      memberItemIndices={members.map((_, i) => i)}
                      working={working}
                    />
                  </BackgroundToolProvider>
                </QuestionAnswersProvider>
              </PlanStatusProvider>
            </ToolResultProvider>
          </ToolStatusProvider>
        </>
      )
    }
    const { container, getByTestId } = render(<Harness />)
    expect(isOpen(container)).toBe(true)

    // Tools settle mid-turn (gap before the next tool_use) — must stay open
    fireEvent.click(getByTestId('settle'))
    expect(isOpen(container)).toBe(true)

    // Turn ends → settle hold, then auto-collapse
    fireEvent.click(getByTestId('turn-end'))
    expect(isOpen(container)).toBe(true)
    act(() => {
      vi.advanceTimersByTime(2300)
    })
    expect(isOpen(container)).toBe(false)
  })

  it('shows failed badge when collapsed and a tool errored', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'error'],
      ]),
    })
    expect(isOpen(container)).toBe(false)
    expect(container.querySelector('.tool-status-error')).not.toBeNull()
  })

  it('keeps a pending-plan group open (and shows waiting) even after a manual close', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('p1', 'ExitPlanMode')],
      toolStatus: new Map<string, ToolStatus>([['t1-tu', 'success']]),
      planStatus: new Map([['p1-tu', 'pending' as const]]),
    })
    expect(isOpen(container)).toBe(true)
    fireEvent.click(container.querySelector('.tool-group-summary-inner')!)
    // pending interactive also force-opens — a folded plan would stall the turn
    expect(isOpen(container)).toBe(true)
    expect(container.textContent).toContain('waiting')
    expect(container.querySelector('.tool-group-has-pending')).not.toBeNull()
  })

  it('toggles on header click', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'success'],
      ]),
    })
    fireEvent.click(container.querySelector('.tool-group-summary-inner')!)
    expect(isOpen(container)).toBe(true)
    fireEvent.click(container.querySelector('.tool-group-summary-inner')!)
    expect(isOpen(container)).toBe(false)
  })

  it('force-expands only when the group may match the search query', () => {
    const settled = new Map<string, ToolStatus>([
      ['t1-tu', 'success'],
      ['t2-tu', 'success'],
    ])
    const miss = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2', 'Grep')],
      toolStatus: settled,
      searchQuery: 'needle',
    })
    expect(isOpen(miss.container)).toBe(false)

    const hit = renderGroup({
      members: [toolMsg('t1', 'Read', { file_path: 'needle.ts' }), toolMsg('t2')],
      toolStatus: settled,
      searchQuery: 'needle',
    })
    expect(isOpen(hit.container)).toBe(true)
  })

  it('treats a missing tool id as running so an in-flight card never folds', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([['t2-tu', 'success']]), // t1-tu absent
    })
    expect(isOpen(container)).toBe(true)
  })
})
