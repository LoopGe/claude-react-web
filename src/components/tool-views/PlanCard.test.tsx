import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { PlanCard } from './PlanCard'
import { PlanContentProvider, PlanStatusProvider } from '../../hooks/usePlanStatus'
import { ReopenQuestionProvider } from '../../hooks/useReopenQuestion'
import type { ReopenQuestionValue } from '../../hooks/useReopenQuestion'
import type { PlanStatus } from '../../session-store/types'

function providers(status: PlanStatus, options?: { minimized?: boolean; onReopenPlan?: (id: string) => void }) {
  const reopen: ReopenQuestionValue = {
    minimizedToolUseIds: new Set(),
    minimizedPlanToolUseIds: options?.minimized ? new Set(['tu1']) : new Set(),
    minimizedPermissionToolUseIds: new Set(),
    onReopen: () => {},
    onReopenPlan: options?.onReopenPlan ?? (() => {}),
    onReopenPermission: () => {},
  }
  return {
    status: new Map([['tu1', status]]),
    content: new Map<string, string>(),
    reopen,
  }
}

function renderPlan(status: PlanStatus, options?: { minimized?: boolean; onReopenPlan?: (id: string) => void }) {
  const value = providers(status, options)
  return render(
    <PlanStatusProvider value={value.status}>
      <PlanContentProvider value={value.content}>
        <ReopenQuestionProvider value={value.reopen}>
          <PlanCard input={{ plan: '# Refactor\n- simplify approval' }} toolUseId="tu1" />
        </ReopenQuestionProvider>
      </PlanContentProvider>
    </PlanStatusProvider>,
  )
}

describe('PlanCard', () => {
  it.each([
    ['pending', 'Pending review', 'open'],
    ['approved', 'Approved', 'closed'],
    ['rejected', 'Rejected', 'closed'],
  ] as const)('renders %s with the expected label and default disclosure state', (status, label, dataState) => {
    const { container } = renderPlan(status)
    const details = container.querySelector('details')!
    expect(details.getAttribute('data-state')).toBe(dataState)
    expect(details.classList).toContain(status)
    expect(details.classList).toContain('decision-card')
    expect(container.querySelector('.plan-card-status')?.textContent).toBe(label)
    expect(container.querySelector('.plan-card-chevron')).toBeTruthy()
    expect(container.querySelector('.plan-card-chevron')?.classList).toContain('decision-card-chevron')
  })

  it('uses a neutral explanation for a rejected plan', () => {
    const { container } = renderPlan('rejected')
    expect(container.querySelector('.plan-card-status')?.getAttribute('title')).toBe('This plan was not approved.')
  })

  it('collapses by default when a pending plan becomes approved', () => {
    const pending = providers('pending')
    const approved = providers('approved')
    const { container, rerender } = render(
      <PlanStatusProvider value={pending.status}>
        <PlanContentProvider value={pending.content}>
          <ReopenQuestionProvider value={pending.reopen}>
            <PlanCard input={{ plan: 'step' }} toolUseId="tu1" />
          </ReopenQuestionProvider>
        </PlanContentProvider>
      </PlanStatusProvider>,
    )
    expect(container.querySelector('details')!.getAttribute('data-state')).toBe('open')
    rerender(
      <PlanStatusProvider value={approved.status}>
        <PlanContentProvider value={approved.content}>
          <ReopenQuestionProvider value={approved.reopen}>
            <PlanCard input={{ plan: 'step' }} toolUseId="tu1" />
          </ReopenQuestionProvider>
        </PlanContentProvider>
      </PlanStatusProvider>,
    )
    expect(container.querySelector('details')!.getAttribute('data-state')).toBe('closed')
  })

  it('reopens a minimized plan without toggling its disclosure state', () => {
    const onReopenPlan = vi.fn()
    const { container } = renderPlan('pending', { minimized: true, onReopenPlan })
    const details = container.querySelector('details')!
    expect(details.getAttribute('data-state')).toBe('open')
    fireEvent.click(container.querySelector('.plan-card-reopen')!)
    expect(onReopenPlan).toHaveBeenCalledWith('tu1')
    expect(details.getAttribute('data-state')).toBe('open')
  })

  it('does not offer Review plan after the plan is resolved', () => {
    const { container } = renderPlan('approved', { minimized: true })
    expect(container.querySelector('.plan-card-reopen')).toBeNull()
  })
})
