import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SchedulePicker } from './SchedulePicker'

const rect = { left: 100, top: 100, width: 30, height: 30 } as DOMRect

describe('SchedulePicker', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('calls onPick with ~now+10min for the 10-minute preset', () => {
    const onPick = vi.fn()
    const before = Date.now()
    render(<SchedulePicker anchorRect={rect} onPick={onPick} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /10 minutes/i }))
    const [at] = onPick.mock.calls[0] as [number]
    const after = Date.now()
    expect(at).toBeGreaterThan(before + 9.5 * 60_000)
    expect(at).toBeLessThan(after + 10.5 * 60_000)
  })

  it('calls onPick with the chosen custom datetime', () => {
    const onPick = vi.fn()
    render(<SchedulePicker anchorRect={rect} onPick={onPick} onClose={() => {}} />)
    const input = screen.getByLabelText(/custom time/i)
    // 2100-01-02 03:04 local → epoch ms
    fireEvent.change(input, { target: { value: '2100-01-02T03:04' } })
    fireEvent.click(screen.getByRole('button', { name: /schedule send/i }))
    const [at] = onPick.mock.calls[0] as [number]
    expect(new Date(at).toISOString()).toBe(new Date('2100-01-02T03:04').toISOString())
  })

  it('disables confirm while no custom time is set and no preset chosen', () => {
    render(<SchedulePicker anchorRect={rect} onPick={() => {}} onClose={() => {}} />)
    expect((screen.getByRole('button', { name: /schedule send/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('calls onClose on backdrop click', () => {
    const onClose = vi.fn()
    render(<SchedulePicker anchorRect={rect} onPick={() => {}} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('schedule-backdrop'))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
