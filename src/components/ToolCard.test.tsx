// Verifies the per-card "background this task" action on ToolCard: rendered
// only while the card is running, wired to the caller's onBackground, and
// gone once the tool_result settles (backgrounding itself lands a result, so
// the button unmounts without extra state). Runs in jsdom (src/** .tsx).

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { ToolCard, ToolStatusBadge } from './ToolCard'
import { ToolUseBlock } from './ToolUseBlock'
import { ToolStatusProvider } from '../hooks/usePlanStatus'
import { BackgroundToolProvider } from '../hooks/useBackgroundTool'
import type { ToolStatus } from '../session-store/types'
import type { Block } from '../types'

// Spy on the status-resolver hooks (delegating to the real implementations)
// so tests can assert the card badge reuses the card's resolved status
// instead of subscribing to ToolStatusContext a second time.
const { useResolvedToolStatusMock, useToolStatusMock } = vi.hoisted(() => ({
  useResolvedToolStatusMock: vi.fn(),
  useToolStatusMock: vi.fn(),
}))

vi.mock('../hooks/usePlanStatus', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../hooks/usePlanStatus')>()
  return {
    ...mod,
    useResolvedToolStatus: useResolvedToolStatusMock.mockImplementation(mod.useResolvedToolStatus),
    useToolStatus: useToolStatusMock.mockImplementation(mod.useToolStatus),
  }
})

beforeEach(() => {
  useResolvedToolStatusMock.mockClear()
  useToolStatusMock.mockClear()
})

afterEach(() => cleanup())

function renderCard({
  status = 'running' as ToolStatus,
  onBackground,
}: {
  status?: ToolStatus
  onBackground?: () => void
} = {}) {
  return render(
    <ToolStatusProvider value={new Map([['tu-1', status]])}>
      <ToolCard
        icon={<span data-testid="icon" />}
        title="bash"
        toolUseId="tu-1"
        onBackground={onBackground}
      >
        <div>body</div>
      </ToolCard>
    </ToolStatusProvider>,
  )
}

describe('ToolCard background action', () => {
  it('shows the background button while the card is running and routes the click', () => {
    const onBackground = vi.fn()
    const { container } = renderCard({ onBackground })

    const btn = container.querySelector<HTMLButtonElement>('[aria-label="Background this task"]')
    expect(btn).not.toBeNull()
    fireEvent.click(btn!)
    expect(onBackground).toHaveBeenCalledOnce()
  })

  it('hides the background button once the card settles (success or error)', () => {
    for (const status of ['success', 'error'] as const) {
      const { container } = renderCard({ status, onBackground: vi.fn() })
      expect(container.querySelector('[aria-label="Background this task"]')).toBeNull()
    }
  })

  it('renders no background button when onBackground is not provided', () => {
    // The default (context-empty) status is 'running', but no action was
    // wired — e.g. Side Chat drawer / transcript exports.
    const { container } = renderCard()
    expect(container.querySelector('[aria-label="Background this task"]')).toBeNull()
  })

  it('BashToolView wires the button to its own tool_use id; run_in_background cards never offer it', () => {
    const backgroundTool = vi.fn()
    // Empty status map → both cards default to 'running'.
    const { container } = render(
      <BackgroundToolProvider value={backgroundTool}>
        <ToolStatusProvider value={new Map()}>
          <ToolUseBlock block={{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'sleep 300' } } as Block} />
          <ToolUseBlock block={{ type: 'tool_use', id: 'bash-2', name: 'Bash', input: { command: 'sleep 300', run_in_background: true } } as Block} />
        </ToolStatusProvider>
      </BackgroundToolProvider>,
    )

    const buttons = container.querySelectorAll('[aria-label="Background this task"]')
    // Only the foreground command's card offers the action — bash-2 already
    // detached at spawn.
    expect(buttons.length).toBe(1)
    fireEvent.click(buttons[0]!)
    expect(backgroundTool).toHaveBeenCalledTimes(1)
    expect(backgroundTool).toHaveBeenCalledWith('bash-1')
  })
})

describe('ToolCard status badge — single subscription', () => {
  it('reuses the card-resolved status instead of subscribing a second time', () => {
    // ToolCard's background-button gate resolves the tool's status once and
    // passes it down; the badge must render that same value rather than call
    // the resolver again (a second ToolStatusContext subscription that
    // re-renders the badge on every unrelated status change in the message).
    renderCard()
    expect(useResolvedToolStatusMock).toHaveBeenCalledTimes(1)
  })

  it('badge reflects the card-resolved status from context', () => {
    const { container } = render(
      <ToolStatusProvider value={new Map([['tu-1', 'success']])}>
        <ToolCard icon={<span data-testid="icon" />} title="bash" toolUseId="tu-1" />
      </ToolStatusProvider>,
    )
    expect(container.querySelector('.tool-status-label')?.textContent).toBe('done')
  })
})

describe('ToolStatusBadge (standalone)', () => {
  it('renders an explicit status without touching the context', () => {
    render(
      <ToolStatusProvider value={new Map([['tu-1', 'error']])}>
        <ToolStatusBadge toolUseId="tu-1" status="success" />
      </ToolStatusProvider>,
    )
    expect(useResolvedToolStatusMock).not.toHaveBeenCalled()
    expect(useToolStatusMock).not.toHaveBeenCalled()
  })

  it('reads from context when no explicit status is given', () => {
    const { container } = render(
      <ToolStatusProvider value={new Map([['tu-1', 'error']])}>
        <ToolStatusBadge toolUseId="tu-1" />
      </ToolStatusProvider>,
    )
    expect(useToolStatusMock).toHaveBeenCalledWith('tu-1')
    expect(container.querySelector('.tool-status-label')?.textContent).toBe('failed')
  })
})
