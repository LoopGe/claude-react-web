// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { QuestionDialog } from './QuestionDialog'
import type { PermissionRequest } from '../types'

function request(): Extract<PermissionRequest, { kind: 'question' }> {
  return {
    kind: 'question',
    id: 'q1',
    toolName: 'AskUserQuestion',
    questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
    toolUseID: 'tu-q1',
    createdAt: 0,
  }
}

function renderDialog() {
  return render(
    <QuestionDialog
      request={request()}
      onSubmit={vi.fn()}
      onClarify={vi.fn()}
      onSkipAll={vi.fn()}
      onMinimize={vi.fn()}
    />,
  )
}

describe('QuestionDialog Plan-style presentation', () => {
  it('uses an action-oriented dialog title', () => {
    const { getByRole } = renderDialog()
    expect(getByRole('dialog', { name: 'Answer questions' })).toBeTruthy()
  })

  it('puts the primary answer action first in the shared action row', () => {
    const { container } = renderDialog()
    const actions = container.querySelector('.question-actions')!
    expect(actions.classList).toContain('decision-actions')
    expect(actions.querySelector('button')?.textContent).toBe('Send answers')
  })

  it('uses the same icon-button treatment as the plan dialog for Minimize', () => {
    const { getByRole } = renderDialog()
    expect(getByRole('button', { name: 'Minimize' }).classList).toContain('btn-icon')
  })
})
