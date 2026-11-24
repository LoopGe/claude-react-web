// @vitest-environment happy-dom
/** Floating zoom toolbar: presets, steps, transient gesture display, activity reporting. */
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { PdfZoomControls, type PdfZoomControlsHandle } from './PdfZoomControls'

function setup(overrides: Partial<Parameters<typeof PdfZoomControls>[0]> = {}) {
  const props = {
    zoom: 1,
    fitSelected: true,
    visible: true,
    onZoom: vi.fn(),
    onFitWidth: vi.fn(),
    onActiveChange: vi.fn(),
    ...overrides,
  }
  const handle: { current: PdfZoomControlsHandle | null } = { current: null }
  const view = render(
    <PdfZoomControls
      {...props}
      ref={(value) => {
        handle.current = value
      }}
    />,
  )
  return { ...view, props, handle }
}

describe('PdfZoomControls', () => {
  it('shows the rounded percentage and steps by 25% in each direction', () => {
    const { props } = setup({ zoom: 1, fitSelected: false })
    expect(screen.getByRole('toolbar', { name: 'Zoom controls' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Zoom presets' }).textContent).toContain('100%')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(props.onZoom).toHaveBeenLastCalledWith(1.25)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(props.onZoom).toHaveBeenLastCalledWith(0.75)
  })

  it('rounds a gesture scale for display and steps outward from it', () => {
    const { props } = setup({ zoom: 1.37, fitSelected: false })
    expect(screen.getByRole('button', { name: 'Zoom presets' }).textContent).toContain('137%')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(props.onZoom).toHaveBeenLastCalledWith(1.5)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(props.onZoom).toHaveBeenLastCalledWith(1.25)
  })

  it('disables stepping at the range bounds', () => {
    const { rerender, props } = setup({ zoom: 0.25, fitSelected: false })
    expect((screen.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(false)
    rerender(<PdfZoomControls {...props} zoom={4} ref={undefined} />)
    expect((screen.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers fit-width and the fixed presets in the menu', () => {
    const { props } = setup({ zoom: 1.5, fitSelected: false })
    fireEvent.click(screen.getByRole('button', { name: 'Zoom presets' }))
    const labels = [...document.querySelectorAll('.ctx-menu-label')].map((node) => node.textContent)
    expect(labels).toEqual(['Fit width', '25%', '50%', '100%', '150%', '200%'])
    fireEvent.click(screen.getByRole('menuitem', { name: '200%' }))
    expect(props.onZoom).toHaveBeenCalledWith(2)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('selects fit-width from the menu', () => {
    const { props } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Zoom presets' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fit width' }))
    expect(props.onFitWidth).toHaveBeenCalledOnce()
    expect(props.onZoom).not.toHaveBeenCalled()
  })

  it('marks the active row (fit-width or the matching preset)', () => {
    const { rerender, props } = setup({ zoom: 1, fitSelected: true })
    fireEvent.click(screen.getByRole('button', { name: 'Zoom presets' }))
    const marked = () =>
      [...document.querySelectorAll('.ctx-menu-item')].filter((row) => row.textContent?.includes('✓'))
    expect(marked().map((row) => row.textContent)).toEqual(['✓Fit width'])
    fireEvent.click(screen.getByRole('button', { name: 'Zoom presets' }))
    rerender(<PdfZoomControls {...props} zoom={1.5} fitSelected={false} ref={undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom presets' }))
    expect(marked().map((row) => row.textContent)).toEqual(['✓150%'])
  })

  it('returns focus to the trigger when a menu dismissal held it', () => {
    setup()
    const trigger = screen.getByRole('button', { name: 'Zoom presets' })
    fireEvent.click(trigger)
    // autoFocus lands on the first row; clicking a row dismisses the menu.
    expect(document.activeElement?.closest('[role="menu"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '100%' }))
    expect(document.activeElement).toBe(trigger)
  })

  it('shows a transient gesture scale until the committed zoom changes', () => {
    const { handle, rerender, props } = setup({ zoom: 1 })
    act(() => {
      handle.current!.showZoom(1.37)
    })
    expect(screen.getByRole('button', { name: 'Zoom presets' }).textContent).toContain('137%')
    rerender(<PdfZoomControls {...props} zoom={1.37} ref={undefined} />)
    expect(screen.getByRole('button', { name: 'Zoom presets' }).textContent).toContain('137%')
    rerender(<PdfZoomControls {...props} zoom={1.5} ref={undefined} />)
    expect(screen.getByRole('button', { name: 'Zoom presets' }).textContent).toContain('150%')
  })

  it('reports activity for hover, focus, and the open menu', () => {
    const { props } = setup()
    const toolbar = screen.getByRole('toolbar')
    expect(props.onActiveChange).toHaveBeenLastCalledWith(false)
    fireEvent.pointerEnter(toolbar, { pointerType: 'mouse' })
    expect(props.onActiveChange).toHaveBeenLastCalledWith(true)
    fireEvent.pointerLeave(toolbar)
    expect(props.onActiveChange).toHaveBeenLastCalledWith(false)
    // Touch hover does not count as activity (non-hover devices stay visible via CSS).
    fireEvent.pointerEnter(toolbar, { pointerType: 'touch' })
    expect(props.onActiveChange).toHaveBeenLastCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom presets' }))
    expect(props.onActiveChange).toHaveBeenLastCalledWith(true)
  })

  it('mirrors visibility onto the panel for the auto-hide CSS', () => {
    const { rerender, props } = setup({ visible: false })
    const toolbar = screen.getByRole('toolbar')
    expect(toolbar.getAttribute('data-visible')).toBeNull()
    rerender(<PdfZoomControls {...props} visible ref={undefined} />)
    expect(toolbar.getAttribute('data-visible')).toBe('true')
  })
})
