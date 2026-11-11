import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SubagentCard } from './SubagentCard'
import { BackgroundToolProvider } from '../hooks/useBackgroundTool'
import { SubagentProvider, type SubagentContextValue } from '../hooks/useSubagentContext'
import type { ActiveSubagent, SubagentChildCall, SubagentStatus } from '../session-store/types'

const child = (over: Partial<SubagentChildCall> & { toolUseId: string; toolName: string }): SubagentChildCall => ({
  argSummary: '',
  status: 'success',
  ...over,
})

const base = (over: Partial<ActiveSubagent> = {}): ActiveSubagent => ({
  toolUseId: 'tu_sa',
  label: 'analyze auth',
  status: 'running',
  toolCount: 0,
  ...over,
})

function renderCard(
  record: ActiveSubagent,
  backgroundTool?: (toolUseId: string) => void,
) {
  const ctx: SubagentContextValue = {
    index: new Map([[record.toolUseId, record]]),
    messages: [],
    open: vi.fn(),
  }
  render(
    <BackgroundToolProvider value={backgroundTool}>
      <SubagentProvider value={ctx}>
        <SubagentCard toolUseId={record.toolUseId} />
      </SubagentProvider>
    </BackgroundToolProvider>,
  )
  return ctx
}

describe('SubagentCard summary header', () => {
  it('puts the task first and opens the side detail from the header', () => {
    const ctx = renderCard(base({ isAsync: false, toolCount: 2, startedAt: 1_000, endedAt: 5_000 }))
    const header = document.querySelector<HTMLButtonElement>('.subagent-card-header')!
    const status = document.querySelector('.subagent-card-status-dot')!
    const label = document.querySelector('.subagent-card-label')!
    const title = document.querySelector('.subagent-card-title')!
    const meta = document.querySelector('.subagent-card-meta')!

    expect(label.textContent).toBe('analyze auth')
    expect(title.textContent).toBe('Subagent')
    expect(screen.getByRole('img', { name: 'Subagent status: running' })).toBeTruthy()
    expect(status.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(label.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(title.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(document.querySelector('.subagent-card-mode-sync')).toBeTruthy()
    expect(document.querySelector('.subagent-card-elapsed')).toBeTruthy()
    expect(screen.getByText('2 tools')).toBeTruthy()
    expect(document.querySelector('.subagent-card-open')).toBeTruthy()

    fireEvent.click(header)
    expect(ctx.open).toHaveBeenCalledExactlyOnceWith('tu_sa')
  })

  it('uses singular tool count and the async mode label', () => {
    renderCard(base({ isAsync: true, toolCount: 1 }))
    expect(screen.getByText('1 tool')).toBeTruthy()
    expect(document.querySelector('.subagent-card-mode-async')).toBeTruthy()
  })
})

describe('SubagentCard latest activity', () => {
  it.each<SubagentStatus>(['running', 'background', 'pending'])(
    'shows only the most recent child while %s',
    (status) => {
      renderCard(base({
        status,
        toolCount: 3,
        childToolCalls: [
          child({ toolUseId: 'c1', toolName: 'Bash', argSummary: 'npm test' }),
          child({ toolUseId: 'c2', toolName: 'Read', argSummary: 'auth.ts' }),
          child({
            toolUseId: 'c3',
            toolName: 'Grep',
            argSummary: 'session-store',
            status: 'running',
            result: { content: 'CHILD_RESULT', isError: false },
          }),
        ],
      }))

      const latest = document.querySelector('.subagent-card-latest')!
      expect(latest.tagName).toBe('DIV')
      expect(latest.getAttribute('aria-busy')).toBe('true')
      expect(document.querySelectorAll('.subagent-card-latest')).toHaveLength(1)
      expect(Array.from(document.querySelectorAll('.subagent-child-name')).map((el) => el.textContent)).toEqual(['Grep'])
      expect(screen.getByText('session-store')).toBeTruthy()
      expect(screen.queryByText('Bash')).toBeNull()
      expect(screen.queryByText('Read')).toBeNull()
      expect(screen.queryByText('CHILD_RESULT')).toBeNull()
      expect(latest.querySelector('button')).toBeNull()
      expect(document.querySelector('details')).toBeNull()
      expect(document.querySelector('.subagent-children')).toBeNull()
      expect(document.querySelector('.subagent-child-result')).toBeNull()
      expect(document.querySelector('.subagent-child-dot-pulse')).toBeTruthy()
    },
  )

  it('prefers an in-flight child over a newer settled child', () => {
    renderCard(base({
      status: 'running',
      childToolCalls: [
        child({ toolUseId: 'c1', toolName: 'Bash', argSummary: 'npm test', status: 'running' }),
        child({ toolUseId: 'c2', toolName: 'Read', argSummary: 'auth.ts', status: 'success' }),
      ],
    }))

    expect(document.querySelector('.subagent-card-latest .subagent-child-name')?.textContent).toBe('Bash')
    expect(screen.queryByText('Read')).toBeNull()
    expect(document.querySelector('.subagent-child-dot-pulse')).toBeTruthy()
    expect(document.querySelector('.subagent-card-latest')?.getAttribute('aria-busy')).toBe('true')
  })

  it.each([
    { childStatus: 'success', expectedClass: 'subagent-child-row-success' },
    { childStatus: 'error', expectedClass: 'subagent-child-row-error' },
  ] as const)('renders a settled latest child as $childStatus without pulsing', ({ childStatus, expectedClass }) => {
    renderCard(base({
      status: 'running',
      childToolCalls: [child({ toolUseId: 'c1', toolName: 'Read', argSummary: 'auth.ts', status: childStatus })],
    }))

    expect(document.querySelector(`.${expectedClass}`)).toBeTruthy()
    expect(document.querySelector('.subagent-card-latest')?.getAttribute('aria-busy')).toBeNull()
    expect(document.querySelector('.subagent-child-dot-pulse')).toBeNull()
  })

  it.each<SubagentStatus>(['running', 'background', 'pending'])('reserves no activity row without tools while %s', (status) => {
    renderCard(base({ status, childToolCalls: [] }))
    expect(document.querySelector('.subagent-card-latest')).toBeNull()
    expect(document.querySelector('.subagent-child-name')).toBeNull()
  })

  it('omits an empty argument summary', () => {
    renderCard(base({
      childToolCalls: [child({ toolUseId: 'c1', toolName: 'Read', argSummary: '' })],
    }))
    expect(document.querySelector('.subagent-child-arg')).toBeNull()
  })
})

describe('SubagentCard progress and terminal states', () => {
  it.each<SubagentStatus>(['running', 'background'])('shows progress while %s', (status) => {
    renderCard(base({ status, progressSummary: 'Tracing message rows' }))
    expect(document.querySelector('.subagent-card-progress')?.textContent).toBe('Tracing message rows')
  })

  it('keeps latest activity but hides progress while pending', () => {
    renderCard(base({
      status: 'pending',
      progressSummary: 'Stale progress',
      childToolCalls: [child({ toolUseId: 'c1', toolName: 'Read', argSummary: 'auth.ts' })],
    }))
    expect(document.querySelector('.subagent-card-progress')).toBeNull()
    expect(document.querySelector('.subagent-card-latest')).toBeTruthy()
  })

  it.each([
    { status: 'done', icon: 'check' },
    { status: 'rejected', icon: 'triangle-alert' },
    { status: 'interrupted', icon: 'triangle-alert' },
  ] as const)('uses a $icon shape instead of color alone for $status', ({ status, icon }) => {
    renderCard(base({ status }))
    expect(document.querySelector('.subagent-card-status-icon')).toBeTruthy()
    expect(document.querySelector(`.lucide-${icon}`)).toBeTruthy()
    expect(document.querySelector('.subagent-card-status-dot')).toBeNull()
    expect(screen.getByRole('img', { name: `Subagent status: ${status}` })).toBeTruthy()
  })

  it.each<SubagentStatus>(['done', 'rejected', 'interrupted', 'dismissed'])(
    'keeps only the summary header after %s',
    (status) => {
      renderCard(base({
        status,
        progressSummary: 'Stale progress',
        result: { content: 'PARENT_RESULT', isError: status !== 'done' },
        childToolCalls: [child({
          toolUseId: 'c1',
          toolName: 'Read',
          argSummary: 'auth.ts',
          status: 'running',
          result: { content: 'CHILD_RESULT', isError: false },
        })],
      }), vi.fn())

      expect(document.querySelector(`.subagent-card-${status}`)).toBeTruthy()
      expect(document.querySelector('.subagent-card-header')).toBeTruthy()
      expect(document.querySelector('.subagent-card-latest')).toBeNull()
      expect(document.querySelector('.subagent-card-progress')).toBeNull()
      expect(document.querySelector('.subagent-card-actions')).toBeNull()
      expect(document.querySelector('details')).toBeNull()
      expect(screen.queryByText('PARENT_RESULT')).toBeNull()
      expect(screen.queryByText('CHILD_RESULT')).toBeNull()
    },
  )
})

describe('SubagentCard background action', () => {
  it('backgrounds a synchronous running subagent by tool id', () => {
    const backgroundTool = vi.fn()
    renderCard(base({ status: 'running', isAsync: false }), backgroundTool)
    fireEvent.click(screen.getByRole('button', { name: 'Background this subagent' }))
    expect(backgroundTool).toHaveBeenCalledExactlyOnceWith('tu_sa')
  })

  it('hides the action for async or already-background subagents', () => {
    renderCard(base({ status: 'background', isAsync: true }), vi.fn())
    expect(screen.queryByRole('button', { name: 'Background this subagent' })).toBeNull()
  })

  it('hides the action when the host does not provide backgrounding', () => {
    renderCard(base({ status: 'running', isAsync: false }))
    expect(screen.queryByRole('button', { name: 'Background this subagent' })).toBeNull()
  })
})
