import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { SessionBody, errorCardState } from './SessionErrorCard'

// ProjectPicker 的内部行为归它自己的测试；这里只钉卡片的装配契约。
vi.mock('./session-list/ProjectPicker', () => ({
  ProjectPicker: (props: {
    value: string
    recents: string[]
    onSelect: (p: string) => void
    onForget: (p: string) => void
    onBrowse: () => void
  }) => (
    <div
      data-testid="project-picker"
      data-value={props.value}
      data-recents={props.recents.join('|')}
    >
      <button data-testid="picker-select" onClick={() => props.onSelect('/picked/path')}>select</button>
      <button data-testid="picker-forget" onClick={() => props.onForget(props.recents[0])}>forget</button>
      <button data-testid="picker-browse" onClick={props.onBrowse}>browse</button>
    </div>
  ),
}))

describe('errorCardState', () => {
  it('returns null when the session has no error', () => {
    expect(errorCardState({ running: false, terminated: true, error: undefined })).toBeNull()
    expect(errorCardState({ running: false, terminated: false, recovering: true, error: '' })).toBeNull()
  })

  it('returns null for a running session carrying a stale error, keeping its live UI', () => {
    // session-status.ts documents this 'err' state: a RUNNING session that
    // has nonetheless errored. The transcript/composer must stay mounted.
    expect(errorCardState({ running: true, terminated: false, error: 'boom' })).toBeNull()
  })

  it('maps a dormant errored session to the dormant card', () => {
    expect(errorCardState({ running: false, terminated: false, error: 'Working directory not found: /gone' })).toEqual({
      kind: 'dormant',
      error: 'Working directory not found: /gone',
    })
  })

  it('maps a terminated errored session to the terminated card', () => {
    expect(errorCardState({ running: false, terminated: true, error: 'boom' })).toEqual({
      kind: 'terminated',
      error: 'boom',
    })
  })

  it('returns null for a recovering session — its paired crash-recovery notices must resolve live', () => {
    expect(errorCardState({ running: true, terminated: false, recovering: true, error: 'boom' })).toBeNull()
  })
})

describe('SessionBody', () => {
  it('renders children untouched when the session has no error', () => {
    render(
      <SessionBody session={{ running: false, terminated: false }}>
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    expect(screen.getByTestId('msgs')).toBeTruthy()
    expect(screen.queryByText('Session is dormant')).toBeNull()
  })

  it('renders children for a running session carrying a stale error', () => {
    render(
      <SessionBody session={{ running: true, terminated: false, error: 'stale' }}>
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    expect(screen.getByTestId('msgs')).toBeTruthy()
  })

  it('replaces children with the dormant card when a dormant session errored', () => {
    const onResume = vi.fn()
    render(
      <SessionBody session={{ running: false, terminated: false, error: 'cwd gone' }} onResume={onResume}>
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    // 消息列表让位
    expect(screen.queryByTestId('msgs')).toBeNull()
    expect(screen.getByText('Session is dormant')).toBeTruthy()
    expect(screen.getByText(/cwd gone/)).toBeTruthy()
    expect(screen.getByText(/below to try again/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Resume session' }))
    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it('omits the resume button and its instruction when no resume handler is wired', () => {
    render(
      <SessionBody session={{ running: false, terminated: false, error: 'cwd gone' }}>
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    expect(screen.getByText(/cwd gone/)).toBeTruthy()
    expect(screen.queryByText(/below to try again/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows resume and fork actions for a retryable terminated session', async () => {
    const onResume = vi.fn()
    const onFork = vi.fn()
    render(
      <SessionBody
        session={{ running: false, terminated: true, canRetryResume: true, error: 'boom' }}
        onResume={onResume}
        onFork={onFork}
      >
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    expect(screen.queryByTestId('msgs')).toBeNull()
    expect(screen.getByText('Session terminated')).toBeTruthy()
    expect(screen.getByText(/boom/)).toBeTruthy()
    expect(screen.getByText(/Resume to continue in place, or fork from your last completed turn/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(onResume).toHaveBeenCalledTimes(1)
    await act(async () => {}) // 动作 settle 后按钮复位，可再点另一颗
    fireEvent.click(screen.getByRole('button', { name: 'Fork from last completed turn' }))
    expect(onFork).toHaveBeenCalledTimes(1)
  })

  it('shows the dead-end hint with no buttons when the terminated session cannot retry', () => {
    render(
      <SessionBody
        session={{ running: false, terminated: true, error: 'gone for good' }}
        onResume={vi.fn()}
        onFork={vi.fn()}
      >
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    expect(screen.getByText('Session terminated')).toBeTruthy()
    expect(screen.getByText(/Create a new session to continue/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('names only the resume action when fork is not wired on a retryable terminated session', () => {
    render(
      <SessionBody
        session={{ running: false, terminated: true, canRetryResume: true, error: 'boom' }}
        onResume={vi.fn()}
      >
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy()
    expect(screen.queryByText(/fork from your last completed turn/)).toBeNull()
    expect(screen.getByText(/Resume to continue in place/)).toBeTruthy()
  })

  it('names only the fork action when resume is not wired on a retryable terminated session', () => {
    render(
      <SessionBody
        session={{ running: false, terminated: true, canRetryResume: true, error: 'boom' }}
        onFork={vi.fn()}
      >
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Fork from last completed turn' })).toBeTruthy()
    expect(screen.getByText(/Use .Fork from last completed turn. below to continue/)).toBeTruthy()
  })

  it('keeps children mounted for a recovering session so its paired crash-recovery notices resolve', () => {
    // The server's "正在尝试自动恢复… / 已从崩溃恢复" notice pair is pushed to
    // live subscribers only — unmounting the transcript view (and its
    // SessionSynchronizer subscription) strands the first row without its
    // resolution.
    render(
      <SessionBody session={{ running: true, terminated: false, recovering: true, error: 'cli crashed' }}>
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    expect(screen.getByTestId('msgs')).toBeTruthy()
    expect(screen.queryByText('Recovering session…')).toBeNull()
  })

  it('shows the resuming spinner instead of the card while a resume is in flight', () => {
    render(
      <SessionBody session={{ running: false, terminated: false, error: 'cwd gone' }} onResume={vi.fn()} resuming>
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    expect(screen.queryByTestId('msgs')).toBeNull()
    expect(screen.getByText('Resuming session...')).toBeTruthy()
    expect(screen.queryByText('Session is dormant')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('disables the action buttons after the first click to prevent double-fire', () => {
    const onResume = vi.fn()
    const onFork = vi.fn()
    render(
      <SessionBody
        session={{ running: false, terminated: true, canRetryResume: true, error: 'boom' }}
        onResume={onResume}
        onFork={onFork}
      >
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Fork from last completed turn' }))
    expect(onFork).toHaveBeenCalledTimes(1)
    // 全部动作按钮进入禁用——第二次点击打不出第二个请求
    expect((screen.getByRole('button', { name: 'Fork from last completed turn' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Fork from last completed turn' }))
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(onFork).toHaveBeenCalledTimes(1)
    expect(onResume).not.toHaveBeenCalled()
  })

  it('re-enables the action buttons once a settled action finishes, so a failed fork can be retried', async () => {
    const onFork = vi.fn().mockResolvedValue(undefined) // App 吞掉失败并 resolve
    render(
      <SessionBody
        session={{ running: false, terminated: true, canRetryResume: true, error: 'boom' }}
        onFork={onFork}
      >
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Fork from last completed turn' }))
    expect((screen.getByRole('button', { name: 'Fork from last completed turn' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {})
    expect((screen.getByRole('button', { name: 'Fork from last completed turn' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not double the punctuation when the error already ends with a period', () => {
    render(
      <SessionBody session={{ running: false, terminated: false, error: 'cwd gone.' }} onResume={vi.fn()}>
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    expect(screen.queryByText(/\.\./)).toBeNull()
  })

  it('re-enables the action buttons when an action throws synchronously instead of dead-ending the card', () => {
    const onFork = vi.fn(() => {
      throw new Error('sync boom')
    })
    render(
      <SessionBody
        session={{ running: false, terminated: true, canRetryResume: true, error: 'boom' }}
        onFork={onFork}
      >
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    const btn = screen.getByRole('button', { name: 'Fork from last completed turn' }) as HTMLButtonElement
    // React 的事件分发层全局上报这个异常（不穿透 fireEvent）——断言只看
    // 按钮没有被永久卡死。
    fireEvent.click(btn)
    expect(btn.disabled).toBe(false)
  })

  it('shows the resuming spinner for a dormant session with no error as well', () => {
    render(
      <SessionBody session={{ running: false, terminated: false }} resuming>
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    expect(screen.queryByTestId('msgs')).toBeNull()
    expect(screen.getByText('Resuming session...')).toBeTruthy()
  })

  it('renders the stderr tail as a collapsed disclosure on the card', () => {
    render(
      <SessionBody
        session={{ running: false, terminated: false, error: 'boom' }}
        onResume={vi.fn()}
        stderrTail={['stderr line one', 'stderr line two']}
      >
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    expect(screen.getByText('stderr')).toBeTruthy()
    expect(screen.getByText(/stderr line one/)).toBeTruthy()
    expect(screen.getByText(/stderr line two/)).toBeTruthy()
  })

  it('mounts the new-session project picker on the dormant error card, wired to the relocation handlers', () => {
    const onSelect = vi.fn()
    const onForget = vi.fn()
    const onBrowse = vi.fn()
    render(
      <SessionBody
        session={{ running: false, terminated: false, error: 'cwd gone', cwd: 'D:\\codes\\ai-rootcause' }}
        onResume={vi.fn()}
        workspace={{ recents: ['/a', '/b'], onSelect, onForget, onBrowse }}
      >
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    const picker = screen.getByTestId('project-picker')
    expect(picker.dataset.value).toBe('D:\\codes\\ai-rootcause')
    expect(picker.dataset.recents).toBe('/a|/b')
    fireEvent.click(screen.getByTestId('picker-select'))
    expect(onSelect).toHaveBeenCalledWith('/picked/path')
    fireEvent.click(screen.getByTestId('picker-forget'))
    expect(onForget).toHaveBeenCalledWith('/a')
    fireEvent.click(screen.getByTestId('picker-browse'))
    expect(onBrowse).toHaveBeenCalled()
  })

  it('mounts the project picker on the terminated error card too', () => {
    render(
      <SessionBody
        session={{ running: false, terminated: true, canRetryResume: true, error: 'boom', cwd: '/old' }}
        onFork={vi.fn()}
        workspace={{ recents: [], onSelect: vi.fn(), onForget: vi.fn(), onBrowse: vi.fn() }}
      >
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    expect(screen.getByTestId('project-picker')).toBeTruthy()
  })

  it('omits the project picker when no relocation wiring is provided', () => {
    render(
      <SessionBody session={{ running: false, terminated: false, error: 'boom', cwd: '/old' }} onResume={vi.fn()}>
        <div data-testid="msgs">messages</div>
      </SessionBody>,
    )
    expect(screen.queryByTestId('project-picker')).toBeNull()
  })
})
