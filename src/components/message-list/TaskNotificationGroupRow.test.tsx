import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { SdkMessage } from '../../types'
import { TaskNotificationGroupRow } from './views/frame-views'

const notifMsg = (i: number): SdkMessage =>
  ({
    type: 'user',
    uuid: `n${i}`,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: `<task-notification><task-id>t${i}</task-id><tool-use-id>tu${i}</tool-use-id><status>completed</status><summary>Background command "task ${i}" completed</summary><result>exit 0</result></task-notification>`,
    },
  }) as unknown as SdkMessage

describe('TaskNotificationGroupRow', () => {
  it('renders a collapsed one-line summary; member cards hidden until toggled', () => {
    const { container } = render(
      <TaskNotificationGroupRow members={[notifMsg(1), notifMsg(2), notifMsg(3)]} memberItemIndices={[0, 1, 2]} expanded={false} onToggle={() => {}} />,
    )
    expect(screen.getByText(/background tasks · 3 completed/i)).toBeTruthy()
    // Member cards are NOT rendered while collapsed.
    expect(screen.queryByText(/task 1/)).toBeNull()
    expect(container.querySelectorAll('.task-notification-group-body')).toHaveLength(0)
  })

  it('expands to the per-notification cards when expanded, each with its summary', () => {
    render(
      <TaskNotificationGroupRow members={[notifMsg(1), notifMsg(2)]} memberItemIndices={[0, 1]} expanded onToggle={() => {}} />,
    )
    expect(screen.getByText(/Background command "task 1" completed/)).toBeTruthy()
    expect(screen.getByText(/Background command "task 2" completed/)).toBeTruthy()
    expect(container0()?.querySelectorAll('.task-notification')).toHaveLength(2)
  })

  it('toggle callback fires on summary click (controlled expansion)', () => {
    let toggles = 0
    const { container } = render(
      <TaskNotificationGroupRow members={[notifMsg(1), notifMsg(2)]} memberItemIndices={[0, 1]} expanded={false} onToggle={() => { toggles += 1 }} />,
    )
    fireEvent.click(container.querySelector('.task-notification-group-summary')!)
    expect(toggles).toBe(1)
  })

  it('applies the active search match only to the member it navigated to', () => {
    render(
      <TaskNotificationGroupRow
        members={[notifMsg(1), notifMsg(2)]}
        memberItemIndices={[0, 4]}
        expanded
        onToggle={() => {}}
        searchQuery="exit 0"
        activeMemberItemIndex={4}
        activeMatchIdx={0}
      />,
    )
    const cards = document.body.querySelectorAll('.task-notification')
    expect(cards).toHaveLength(2)
    // Exactly ONE active mark in the whole expanded group, and it lives in
    // the member whose itemIndex matches activeMemberItemIndex — not echoed
    // onto every card.
    const active = document.body.querySelectorAll('mark.search-hl-active')
    expect(active).toHaveLength(1)
    expect(cards[1]!.contains(active[0]!)).toBe(true)
  })

  function container0() {
    // eslint hint: kept trivial so both renders above can reuse one getter.
    return document.body
  }
})
