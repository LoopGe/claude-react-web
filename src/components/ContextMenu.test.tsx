// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { AnimatePresence } from 'motion/react'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { expectPortaledToBody } from './portal-test-utils'

afterEach(() => {
  cleanup()
})

// The menu positions itself via useLayoutEffect using real getBoundingClientRect;
// jsdom returns 0s, which is fine — we only assert on item/separator rendering.
describe('ContextMenu', () => {
  it('collapses consecutive separators into one', () => {
    const items: ContextMenuItem[] = [
      { label: 'A', onClick: () => {} },
      { label: '' },
      { label: '' },
      { label: 'B', onClick: () => {} },
    ]
    render(
      <ContextMenu x={0} y={0} items={items} onClose={() => {}} />,
    )
    const seps = document.querySelectorAll('.ctx-menu-sep')
    expect(seps.length).toBe(1)
    const labels = Array.from(document.querySelectorAll('.ctx-menu-label')).map((e) => e.textContent)
    expect(labels).toEqual(['A', 'B'])
  })

  it('trims leading and trailing separators', () => {
    const items: ContextMenuItem[] = [
      { label: '' },
      { label: 'A', onClick: () => {} },
      { label: '' },
    ]
    render(
      <ContextMenu x={0} y={0} items={items} onClose={() => {}} />,
    )
    expect(document.querySelectorAll('.ctx-menu-sep').length).toBe(0)
    expect(document.querySelectorAll('.ctx-menu-label').length).toBe(1)
  })

  it('keeps a single separator between two real items', () => {
    const items: ContextMenuItem[] = [
      { label: 'A', onClick: () => {} },
      { label: '' },
      { label: 'B', onClick: () => {} },
    ]
    render(
      <ContextMenu x={0} y={0} items={items} onClose={() => {}} />,
    )
    expect(document.querySelectorAll('.ctx-menu-sep').length).toBe(1)
  })

  it('fires onClick then onClose when a real item is clicked', () => {
    const onItem = vi.fn()
    const onClose = vi.fn()
    const items: ContextMenuItem[] = [{ label: 'Run', onClick: onItem }]
    render(
      <ContextMenu x={0} y={0} items={items} onClose={onClose} />,
    )
    fireEvent.click(document.querySelector('.ctx-menu-item')!)
    expect(onItem).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps the menu mounted through the exit animation, then unmounts (AnimatePresence)', async () => {
    // Open/close motion is now driven by motion.div + AnimatePresence (the
    // old isExiting/data-state="closing" prop is gone). Smoke test that
    // AnimatePresence retains the node while exiting and removes it after.
    // The retention assertion (not just the eventual unmount) guards against
    // motion short-circuiting the exit in jsdom and unmounting instantly.
    const items: ContextMenuItem[] = [{ label: 'Run', onClick: () => {} }]
    function Harness({ open }: { open: boolean }) {
      return (
        <AnimatePresence>
          {open && <ContextMenu key="m" x={0} y={0} items={items} onClose={() => {}} />}
        </AnimatePresence>
      )
    }
    const { rerender } = render(<Harness open={true} />)
    expect(document.querySelector('.ctx-menu')).not.toBeNull()

    rerender(<Harness open={false} />)
    expect(document.querySelector('.ctx-menu')).not.toBeNull()

    await waitFor(() => {
      expect(document.querySelector('.ctx-menu')).toBeNull()
    })
  })

  it('portals to <body> so its viewport coordinates are honoured', () => {
    const items: ContextMenuItem[] = [{ label: 'Run', onClick: () => {} }]
    const { container } = render(<ContextMenu x={10} y={20} items={items} onClose={() => {}} />)
    expectPortaledToBody(container, '.ctx-menu')
  })

  it('dismisses on an outside mousedown but not on one inside the portalled menu', () => {
    // The dismissal listener is on `window`; staying open is the root's own
    // onMouseDown stopPropagation. That is exactly the seam portalling moved —
    // React now delegates this subtree at <body> instead of at the panel — so
    // it gets a direct assertion rather than riding on the containment guard.
    const onClose = vi.fn()
    const items: ContextMenuItem[] = [{ label: 'Run', onClick: () => {} }]
    render(<ContextMenu x={10} y={20} items={items} onClose={onClose} />)

    fireEvent.mouseDown(document.querySelector('.ctx-menu-item')!)
    fireEvent.mouseDown(document.querySelector('.ctx-menu-label')!)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.mouseDown(document.documentElement)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
