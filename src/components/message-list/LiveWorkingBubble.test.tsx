import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { PresenceContext } from 'motion/react'
import type { ReactNode } from 'react'
import { LiveWorkingBubble } from './WorkingBubble'
import { getSessionStore } from '../../session-store/selectors'
import { sessionStoreRegistry } from '../../session-store/registry'
import type { SdkMessage } from '../../types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function streamEvent(event: Record<string, unknown>): SdkMessage {
  return { type: 'stream_event', parent_tool_use_id: null, event } as unknown as SdkMessage
}
function blockStart(content_block: Record<string, unknown>): SdkMessage {
  return streamEvent({ type: 'content_block_start', index: 0, content_block })
}
function send(sid: string, message: SdkMessage) {
  getSessionStore(sid).dispatch({ type: 'MESSAGE', message })
}
/** Two real output_tokens samples 600ms apart → (120-50)/0.6 = 117 tok/s. */
function seedRate(sid: string) {
  const now = vi.spyOn(Date, 'now')
  now.mockReturnValue(1000)
  send(sid, streamEvent({ type: 'message_delta', usage: { output_tokens: 50 } }))
  now.mockReturnValue(1600)
  send(sid, streamEvent({ type: 'message_delta', usage: { output_tokens: 120 } }))
  now.mockRestore()
}

/** Simulates AnimatePresence's per-child context: `isPresent: false` is the
 *  state of a child whose exit animation is playing. */
function Presence({ present, children }: { present: boolean; children: ReactNode }) {
  return (
    <PresenceContext.Provider value={{ id: 'p', initial: false, isPresent: present, custom: undefined, onExitComplete: undefined, register: () => () => {} } as never}>
      {children}
    </PresenceContext.Provider>
  )
}

const label = (c: HTMLElement) => c.querySelector('.working-bar-label')?.textContent ?? null

afterEach(async () => {
  vi.restoreAllMocks()
  await sessionStoreRegistry.clear()
})

describe('LiveWorkingBubble', () => {
  it('shows the store’s phase and token rate without a parent re-render', async () => {
    const sid = 'lwb-live'
    const { container } = render(<LiveWorkingBubble sessionId={sid} active />)
    expect(label(container)).toBe('Working')
    act(() => { send(sid, blockStart({ type: 'text', text: '' })) })
    expect(label(container)).toBe('Writing...')
    expect(container.querySelector('.working-rate')).toBeNull()
    act(() => { seedRate(sid) })
    expect(getSessionStore(sid).getSnapshot().tokenRate).toBe(117)
    expect(container.querySelector('.working-rate')).not.toBeNull()
  })

  it('dwellPhase holds a new phase for 300ms (the main panel); without it the raw phase shows (the side drawer)', async () => {
    const sid = 'lwb-dwell'
    const { container } = render(
      <>
        <div data-testid="dwell"><LiveWorkingBubble sessionId={sid} active dwellPhase /></div>
        <div data-testid="raw"><LiveWorkingBubble sessionId={sid} active /></div>
      </>,
    )
    const dwell = container.querySelector('[data-testid="dwell"]') as HTMLElement
    const raw = container.querySelector('[data-testid="raw"]') as HTMLElement
    act(() => { send(sid, blockStart({ type: 'thinking' })) })
    // null → phase commits immediately on both.
    expect(label(dwell)).toBe('Thinking...')
    expect(label(raw)).toBe('Thinking...')
    act(() => { send(sid, blockStart({ type: 'text', text: '' })) })
    // phase → phase: the dwelled label holds, the raw one switches.
    expect(label(dwell)).toBe('Thinking...')
    expect(label(raw)).toBe('Writing...')
    await act(() => sleep(380))
    expect(label(dwell)).toBe('Writing...')
  })

  it('freezes phase / rate / thinking tokens while its exit animation plays', () => {
    const sid = 'lwb-exit'
    const tree = (present: boolean) => (
      <Presence present={present}>
        <LiveWorkingBubble sessionId={sid} active dwellPhase showThinkingTokens />
      </Presence>
    )
    const { container, rerender } = render(tree(true))
    act(() => {
      send(sid, blockStart({ type: 'text', text: '' }))
      seedRate(sid)
    })
    expect(label(container)).toBe('Writing...')
    expect(container.querySelector('.working-rate')).not.toBeNull()

    // The exit starts, then the turn-end sweep nulls the live turn. The
    // fading bubble must keep showing what it showed at the exit's start —
    // exactly what a retained element with frozen props did before.
    rerender(tree(false))
    act(() => { send(sid, { type: 'result', uuid: 'r-exit', subtype: 'success' } as unknown as SdkMessage) })
    expect(getSessionStore(sid).getSnapshot().tokenRate).toBeNull()
    expect(getSessionStore(sid).getSnapshot().activePhase).toBeNull()
    expect(label(container)).toBe('Writing...')
    expect(container.querySelector('.working-rate')).not.toBeNull()

    // Re-entering (AnimatePresence brings the same child back) resumes live values.
    rerender(tree(true))
    expect(label(container)).toBe('Working')
    expect(container.querySelector('.working-rate')).toBeNull()
  })

  it('shows the redacted-thinking estimate only when showThinkingTokens is set', () => {
    const sid = 'lwb-thinking'
    const { container } = render(
      <>
        <div data-testid="main"><LiveWorkingBubble sessionId={sid} active showThinkingTokens /></div>
        <div data-testid="side"><LiveWorkingBubble sessionId={sid} active /></div>
      </>,
    )
    act(() => {
      send(sid, blockStart({ type: 'thinking' }))
      send(sid, { type: 'system', subtype: 'thinking_tokens', uuid: 'tt', estimated_tokens: 4200 } as unknown as SdkMessage)
    })
    const main = container.querySelector('[data-testid="main"]') as HTMLElement
    const side = container.querySelector('[data-testid="side"]') as HTMLElement
    expect(main.querySelector('.working-rate')?.textContent).toContain('~4.2k tok')
    expect(side.querySelector('.working-rate')).toBeNull()
  })
})
