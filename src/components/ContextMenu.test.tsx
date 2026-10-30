import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { AnimatePresence } from 'motion/react'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { closeAllContextMenus } from './context-menu-registry'
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

  it('does not steal focus unless autoFocus is set (right-click menus keep the editor focused)', () => {
    const items: ContextMenuItem[] = [{ label: 'Run', onClick: () => {} }]
    const editor = document.createElement('textarea')
    document.body.append(editor)
    editor.focus()
    render(<ContextMenu x={0} y={0} items={items} onClose={() => {}} />)
    expect(document.activeElement).toBe(editor)
    editor.remove()
  })

  it('autoFocus lands on the first enabled item with preventScroll', () => {
    const items: ContextMenuItem[] = [
      { label: 'Skip', disabled: true, onClick: () => {} },
      { label: 'Run', onClick: () => {} },
    ]
    render(<ContextMenu x={0} y={0} items={items} onClose={() => {}} autoFocus />)
    const enabled = document.querySelectorAll<HTMLButtonElement>('.ctx-menu-item')[1]
    expect(document.activeElement).toBe(enabled)
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

  it('opening a second menu closes the first (no stacked portals across owners)', () => {
    // Owners only know their own visibility state (App's strip menus vs
    // SessionList's card/group menus), and outside right-clicks deliberately
    // don't dismiss (a right-click must REPLACE its own menu). Mounting a
    // second menu must therefore close the first itself — otherwise the
    // buried portal's items stay clickable at its peeking edges.
    const onCloseFirst = vi.fn()
    const items: ContextMenuItem[] = [{ label: 'Run', onClick: () => {} }]
    function Harness({ second }: { second: boolean }) {
      return (
        <>
          <ContextMenu x={0} y={0} items={items} onClose={onCloseFirst} />
          {second && <ContextMenu x={10} y={10} items={items} onClose={() => {}} />}
        </>
      )
    }
    const { rerender } = render(<Harness second={false} />)
    expect(onCloseFirst).not.toHaveBeenCalled()

    rerender(<Harness second={true} />)
    expect(onCloseFirst).toHaveBeenCalledOnce()
  })

  it('repositioning an open menu (owner replace flow) does not close it', () => {
    // Right-clicking another row of the same surface swaps the anchor on the
    // SAME mounted menu (no remount) — the registry must not treat that as a
    // second menu and close the very menu being repositioned.
    const onClose = vi.fn()
    const items: ContextMenuItem[] = [{ label: 'Run', onClick: () => {} }]
    const { rerender } = render(<ContextMenu x={0} y={0} items={items} onClose={onClose} />)
    rerender(<ContextMenu x={50} y={50} items={items} onClose={onClose} />)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closeAllContextMenus dismisses every open menu across owners', () => {
    // Layout shifts (sidebar toggle / keyboard sidebar resize) detach every
    // pinned anchor at once; owners can't each be reached from the shift
    // source (the + create menu's state lives inside CreateMenuButton), so
    // the registry exposes a global dismiss.
    const onCloseA = vi.fn()
    const onCloseB = vi.fn()
    const items: ContextMenuItem[] = [{ label: 'Run', onClick: () => {} }]
    render(
      <>
        <ContextMenu x={0} y={0} items={items} onClose={onCloseA} />
        <ContextMenu x={10} y={10} items={items} onClose={onCloseB} />
      </>,
    )
    // Two menus mounting in one commit: the second's registry effect already
    // closed the first, leaving only B live. closeAll must dismiss whatever
    // is still open regardless of owner.
    expect(onCloseA).toHaveBeenCalledOnce()
    closeAllContextMenus()
    expect(onCloseB).toHaveBeenCalledOnce()
  })
})
