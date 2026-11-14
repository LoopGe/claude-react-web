import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { QuestionCard } from './QuestionCard'
import { QuestionAnswersProvider } from '../../hooks/useQuestionAnswers'
import { ReopenQuestionProvider } from '../../hooks/useReopenQuestion'
import type { ReopenQuestionValue } from '../../hooks/useReopenQuestion'
import type { QuestionAnswerEntry } from '../../utils/question-answers'

const questions = [{
  header: 'Approach',
  question: 'Which approach should I use?',
  options: [
    { label: 'Unified', description: 'Match the plan card.' },
    { label: 'Legacy', description: 'Keep the old treatment.' },
  ],
}]

function reopenValue(options?: { minimized?: boolean; onReopen?: (id: string) => void }): ReopenQuestionValue {
  return {
    minimizedToolUseIds: options?.minimized ? new Set(['tu1']) : new Set(),
    minimizedPlanToolUseIds: new Set(),
    minimizedPermissionToolUseIds: new Set(),
    onReopen: options?.onReopen ?? (() => {}),
    onReopenPlan: () => {},
    onReopenPermission: () => {},
  }
}

function renderQuestion(
  answers: readonly QuestionAnswerEntry[] | undefined,
  options?: { minimized?: boolean; onReopen?: (id: string) => void },
) {
  const value = new Map<string, QuestionAnswerEntry[]>()
  if (answers) value.set('tu1', [...answers])
  return render(
    <QuestionAnswersProvider value={value}>
      <ReopenQuestionProvider value={reopenValue(options)}>
        <QuestionCard input={{ questions }} toolUseId="tu1" />
      </ReopenQuestionProvider>
    </QuestionAnswersProvider>,
  )
}

describe('QuestionCard', () => {
  it.each([
    ['pending', 'Pending answer', 'open', undefined],
    ['answered', 'Answered', 'closed', [{ question: questions[0].question, answer: 'Unified' }]],
    ['skipped', 'Skipped', 'closed', [{ question: questions[0].question, answer: null }]],
    ['clarified', 'Clarified', 'closed', [{ question: questions[0].question, answer: 'More context', clarified: true }]],
  ] as const)('renders %s with Plan-style status copy and disclosure state', (status, label, dataState, answers) => {
    const { container } = renderQuestion(answers)
    const details = container.querySelector('details')!
    expect(details.getAttribute('data-state')).toBe(dataState)
    expect(details.classList).toContain(status)
    expect(details.classList).toContain('decision-card')
    expect(container.querySelector('.question-inline-status')?.textContent).toBe(label)
    expect(container.querySelector('.question-inline-chevron')).toBeTruthy()
    expect(container.querySelector('.question-inline-chevron')?.classList).toContain('decision-card-chevron')
  })

  it('offers an Answer questions action for a minimized pending card', () => {
    const onReopen = vi.fn()
    const { container, getByRole } = renderQuestion(undefined, { minimized: true, onReopen })
    fireEvent.click(getByRole('button', { name: 'Answer questions' }))
    expect(onReopen).toHaveBeenCalledWith('tu1')
    expect(container.querySelector('details')!.getAttribute('data-state')).toBe('open')
  })
})
