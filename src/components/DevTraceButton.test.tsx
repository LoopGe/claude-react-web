// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DevTraceButton } from './DevTraceButton'
import { resetJankMonitorForTests } from '../client-debug/jank-monitor'
import {
  resetTraceDiagnosticsForTests,
  traceFoldScrollActive,
  traceVisualActive,
} from '../client-debug/trace-diagnostics'
import { downloadJson } from '../utils/downloadJson'
import type { TraceFile } from '../client-debug/jank-monitor'
import { __resetFloatingSurfacesForTests as resetEscapeStack } from '../hooks/floating-surface-registry'

vi.mock('../utils/downloadJson', () => ({ downloadJson: vi.fn() }))

beforeEach(() => {
  resetJankMonitorForTests()
  resetTraceDiagnosticsForTests()
  resetEscapeStack()
  localStorage.clear()
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  resetJankMonitorForTests()
  resetTraceDiagnosticsForTests()
  resetEscapeStack()
  localStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function recordButton() {
  return screen.getByRole('button', { name: /recording performance trace|Start recording performance trace|Stop recording performance trace/i })
}

function savedTrace(): TraceFile {
  return vi.mocked(downloadJson).mock.calls[0]?.[1] as TraceFile
}

describe('DevTraceButton', () => {
  it('left-click records with the selected probes and writes lifecycle marks', () => {
    render(<DevTraceButton />)

    fireEvent.click(recordButton())
    expect(traceFoldScrollActive()).toBe(true)
    expect(traceVisualActive()).toBe(true)

    fireEvent.click(recordButton())
    expect(traceFoldScrollActive()).toBe(false)
    expect(traceVisualActive()).toBe(false)
    expect(downloadJson).toHaveBeenCalledOnce()
    const trace = savedTrace()
    expect(trace.crwRaw.recordOptions).toEqual({
      performance: true,
      reactInput: true,
      foldScroll: true,
      visual: true,
    })
    expect(trace.crwRaw.marks.map((mark) => mark.label)).toEqual(expect.arrayContaining([
      'trace record start',
      'trace record stop',
    ]))
  })

  it('right-click opens persistent checkboxes without starting a Record', () => {
    render(<DevTraceButton />)

    fireEvent.contextMenu(recordButton())
    expect(traceFoldScrollActive()).toBe(false)
    expect(screen.getByRole('dialog', { name: 'Trace recording options' })).toBeTruthy()
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(4)
    expect(boxes.every((box) => (box as HTMLInputElement).checked)).toBe(true)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Performance' }))
    expect(JSON.parse(localStorage.getItem('crw:dev-trace-record-options:v1')!).performance).toBe(false)

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.contextMenu(recordButton())
    expect((screen.getByRole('checkbox', { name: 'Performance' }) as HTMLInputElement).checked).toBe(false)
    const appEscape = vi.fn()
    window.addEventListener('keydown', appEscape)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(appEscape).not.toHaveBeenCalled()
    window.removeEventListener('keydown', appEscape)
  })

  it('locks configuration while recording', () => {
    render(<DevTraceButton />)
    fireEvent.click(recordButton())

    fireEvent.contextMenu(recordButton())

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(traceFoldScrollActive()).toBe(true)
  })

  it('can exclude both diagnostic probe groups from a Record', () => {
    render(<DevTraceButton />)
    fireEvent.contextMenu(recordButton())
    fireEvent.click(screen.getByRole('checkbox', { name: 'Fold & scroll geometry' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Visual movement' }))
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(recordButton())
    expect(traceFoldScrollActive()).toBe(false)
    expect(traceVisualActive()).toBe(false)
    fireEvent.click(recordButton())

    expect(savedTrace().crwRaw.recordOptions).toMatchObject({ foldScroll: false, visual: false })
    expect(savedTrace().crwRaw.diagnostics).toEqual([])
  })

  it('keeps Capture on the legacy path with no diagnostic session or Record selection', () => {
    vi.useFakeTimers()
    render(<DevTraceButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Capture performance trace' }))
    expect(traceFoldScrollActive()).toBe(false)
    expect(traceVisualActive()).toBe(false)
    expect((recordButton() as HTMLButtonElement).disabled).toBe(true)
    vi.advanceTimersByTime(2_000)

    expect(downloadJson).toHaveBeenCalledOnce()
    expect(savedTrace().crwRaw.recordOptions).toBeNull()
    expect(savedTrace().crwRaw.diagnostics).toEqual([])
  })
})
