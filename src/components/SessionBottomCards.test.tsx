// Session-bound TodoChecklist + MonitorBar adapter — TDD (Step 1: RED).
//
// Mounts the REAL SessionStore / reducer and the real `TodoChecklist` /
// `MonitorBar` (no mocks of those components — they are the existing
// controlled leaves), and asserts `SessionBottomCards`:
//   - renders nothing when the store has no messages;
//   - derives TodoChecklist content from the store's messages (a TodoWrite
//     tool_use surfaces as a checklist);
//   - derives MonitorBar content from the store's messages (a Monitor
//     tool_use + its start result surfaces as a running monitor row);
//   - shares ONE `messages` subscription between both children (the store
//     is the single source; the wrapper does not pass a `messages` prop to
//     either child).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'

// TodoChecklist / MonitorBar both use AnimatedCollapse (motion/react),
// which touches ResizeObserver + matchMedia — neither is provided by
// happy-dom. Same stubs as TodoChecklist.test.tsx / MonitorBar.test.tsx.
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await sessionStoreRegistry.clear()
})

import { SessionBottomCards } from './SessionBottomCards'
import { getSessionStore } from '../session-store/selectors'
import { sessionStoreRegistry } from '../session-store/registry'
import type { SdkMessage } from '../types'

/** Seed N plain user/assistant messages into the store's seq window. */
function seedMessages(sid: string, msgs: SdkMessage[]) {
  getSessionStore(sid).dispatch({
    type: 'WINDOW_PAGE',
    at: 'tail',
    generation: 0,
    headSeq: msgs.length,
    messages: msgs.map((msg, i) => ({ seq: i, msg })),
    hasMore: false,
    tombstones: [],
  })
}

function assistantToolUse(id: string, name: string, input: Record<string, unknown>): SdkMessage {
  return {
    type: 'assistant',
    uuid: `a-${id}`,
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  } as unknown as SdkMessage
}

function toolResult(toolUseId: string, text: string): SdkMessage {
  return {
    type: 'user',
    uuid: `r-${toolUseId}`,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
  } as unknown as SdkMessage
}

function todoWriteMsg(todos: { content: string; status: string }[]): SdkMessage {
  return assistantToolUse('tu-todo', 'TodoWrite', { todos })
}

function monitorStartedMsgs(toolUseId: string, description: string, taskId = 'mon1'): SdkMessage[] {
  return [
    assistantToolUse(toolUseId, 'Monitor', {
      description,
      command: `echo ${description}`,
      persistent: true,
    }),
    toolResult(toolUseId, `Monitor started (task ${taskId}, shell sh-1)`),
  ]
}

describe('SessionBottomCards', () => {
  it('renders nothing when the store has no messages', () => {
    const sid = 'sbc-empty'
    // No seed — store exists (getOrCreate) but messages is empty.
    const { container } = render(<SessionBottomCards sessionId={sid} />)
    expect(container.querySelector('.todo-panel')).toBeNull()
    expect(container.querySelector('.monitor-bar')).toBeNull()
  })

  it('derives TodoChecklist content from the store messages', () => {
    const sid = 'sbc-todo'
    seedMessages(sid, [
      todoWriteMsg([
        { content: 'Task A', status: 'completed' },
        { content: 'Task B', status: 'in_progress' },
        { content: 'Task C', status: 'pending' },
      ]),
    ])
    const { container } = render(<SessionBottomCards sessionId={sid} working />)
    const panel = container.querySelector('.todo-panel')
    expect(panel).not.toBeNull()
    const items = container.querySelectorAll('.todo-item')
    expect(items.length).toBe(3)
    expect(container.querySelector('.todo-panel-count')?.textContent).toBe('1/3')
  })

  it('derives MonitorBar content from the store messages', () => {
    const sid = 'sbc-monitor'
    seedMessages(sid, monitorStartedMsgs('m1', 'Watch build'))
    const { container } = render(<SessionBottomCards sessionId={sid} />)
    expect(container.querySelector('.monitor-bar')).not.toBeNull()
    expect(container.querySelector('.monitor-text')?.textContent).toBe('Watch build')
    expect(container.querySelector('.monitor-bar-count')?.textContent).toBe('1')
  })

  it('renders both children from the same store messages subscription', () => {
    const sid = 'sbc-both'
    seedMessages(sid, [
      todoWriteMsg([{ content: 'A', status: 'in_progress' }]),
      ...monitorStartedMsgs('m1', 'Watch tests'),
    ])
    const { container } = render(<SessionBottomCards sessionId={sid} working />)
    expect(container.querySelector('.todo-panel')).not.toBeNull()
    expect(container.querySelector('.monitor-bar')).not.toBeNull()
    expect(container.querySelector('.monitor-text')?.textContent).toBe('Watch tests')
  })

  it('does not accept a messages prop — the store is the single source', () => {
    // Compile-time guarantee: the props type omits `messages`. Runtime
    // sanity: passing a `messages` prop through `...rest` would still be
    // ignored because the wrapper reads `messages` from the store and
    // never spreads caller props into the children. We assert that even
    // when the store is empty, a stray `messages`-shaped prop does NOT
    // surface as a rendered checklist.
    const sid = 'sbc-no-messages-prop'
    const { container } = render(
      // @ts-expect-error — `messages` is deliberately not a prop of
      // SessionBottomCards; the store is the single source.
      <SessionBottomCards sessionId={sid} messages={[todoWriteMsg([{ content: 'X', status: 'completed' }])]} />,
    )
    expect(container.querySelector('.todo-panel')).toBeNull()
  })

  it('updates when the store dispatches a fresh TodoWrite', () => {
    const sid = 'sbc-reactive'
    seedMessages(sid, [
      todoWriteMsg([{ content: 'only', status: 'in_progress' }]),
    ])
    const { container } = render(<SessionBottomCards sessionId={sid} working />)
    expect(container.querySelectorAll('.todo-item').length).toBe(1)
    act(() => {
      getSessionStore(sid).dispatch({
        type: 'MESSAGE',
        message: todoWriteMsg([
          { content: 'one', status: 'completed' },
          { content: 'two', status: 'pending' },
        ]) as unknown as SdkMessage,
      })
    })
    expect(container.querySelectorAll('.todo-item').length).toBe(2)
  })
})
