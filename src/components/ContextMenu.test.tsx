import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { AnimatePresence } from 'motion/react'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { closeAllContextMenus } from '../hooks/floating-surface-registry'
import { expectPortaledToBody } from './portal-test-utils'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
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

  it('supports arrow keys, Home/End and cyclic Tab navigation', () => {
    const items: ContextMenuItem[] = [
      { label: 'One', onClick: () => {} },
      { label: 'Two', onClick: () => {} },
      { label: 'Three', onClick: () => {} },
    ]
    render(<ContextMenu x={0} y={0} items={items} onClose={() => {}} autoFocus />)
    const menu = document.querySelector('.ctx-menu')!
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.ctx-menu-item'))
    expect(document.activeElement).toBe(buttons[0])
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(buttons[1])
    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(buttons[2])
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(buttons[0])
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(buttons[2])
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(document.activeElement).toBe(buttons[0])
    fireEvent.keyDown(menu, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(buttons[2])
    fireEvent.keyDown(menu, { key: 'Tab' })
    expect(document.activeElement).toBe(buttons[0])
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

  it('places an above-placed menu using its measured height', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 200,
      top: 0,
      left: 0,
      right: 100,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)
    const items: ContextMenuItem[] = [{ label: 'Run', onClick: () => {} }]
    render(<ContextMenu x={40} y={500} placement="above" items={items} onClose={() => {}} />)
    const menu = document.querySelector<HTMLElement>('.ctx-menu')!
    expect(menu.style.left).toBe('40px')
    expect(menu.style.top).toBe('300px')
  })

  it('keeps an above-placed menu anchored when items are added', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains('ctx-menu')
        ? this.querySelectorAll('.ctx-menu-item').length * 40
        : 0
      return {
        width: 100,
        height,
        top: 0,
        left: 0,
        right: 100,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect
    })
    const first = <ContextMenu x={40} y={500} placement="above" items={[{ label: 'One' }]} onClose={() => {}} />
    const { rerender } = render(first)
    const menu = document.querySelector<HTMLElement>('.ctx-menu')!
    expect(menu.style.top).toBe('460px')

    rerender(<ContextMenu x={40} y={500} placement="above" items={[{ label: 'One' }, { label: 'Two' }]} onClose={() => {}} />)
    expect(menu.style.top).toBe('420px')
  })

  it('re-measures an above-placed menu when rows change without changing item count', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains('ctx-menu')
        ? this.querySelectorAll('.ctx-menu-item').length * 40
        : 0
      return {
        width: 100,
        height,
        top: 0,
        left: 0,
        right: 100,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect
    })
    const { rerender } = render(
      <ContextMenu x={40} y={500} placement="above" items={[{ label: 'One' }]} onClose={() => {}} />,
    )
    const menu = document.querySelector<HTMLElement>('.ctx-menu')!
    expect(menu.style.top).toBe('460px')

    rerender(<ContextMenu x={40} y={500} placement="above" items={[{}]} onClose={() => {}} />)
    expect(menu.style.top).toBe('500px')
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

// Submenu support: a row with `children` renders as a disclosure parent; the
// flyout lives INSIDE the same portal container (a nested portal would trip
// the one-open-at-a-time floating-surface registry and close the parent).
// Open: hover or click on the parent; switch: hovering another row; Escape
// unwinds submenu first, menu second.
describe('ContextMenu submenus', () => {
  function SubmenuHarness(props: { onClose: ReturnType<typeof vi.fn>; onVs: ReturnType<typeof vi.fn> }) {
    const items: ContextMenuItem[] = [
      { label: 'Plain', onClick: () => {} },
      {
        label: 'Open in',
        children: [
          { label: 'VS Code', onClick: props.onVs },
          { label: 'Zed' },
        ],
      },
    ]
    return <ContextMenu x={0} y={0} items={items} onClose={props.onClose} />
  }

  const findParent = (): HTMLButtonElement =>
    [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu-item')].find(
      (b) => b.querySelector('.ctx-menu-label')?.textContent === 'Open in',
    )!

  it('renders the parent row as a disclosure and keeps the flyout closed initially', () => {
    const { onVs } = { onVs: vi.fn() }
    render(<SubmenuHarness onClose={vi.fn()} onVs={onVs} />)
    const labels = Array.from(document.querySelectorAll('.ctx-menu-label')).map((e) => e.textContent)
    expect(labels).toEqual(['Plain', 'Open in']) // flyout rows absent
    const parent = findParent()
    expect(parent.getAttribute('aria-haspopup')).toBe('menu')
    expect(parent.getAttribute('aria-expanded')).toBe('false')
    expect(parent.querySelector('.ctx-menu-arrow')).not.toBeNull()
    expect(document.querySelector('.ctx-submenu')).toBeNull()
  })

  it('opens the flyout on click and fires the child onClick + menu onClose', () => {
    const onVs = vi.fn()
    const onClose = vi.fn()
    render(<SubmenuHarness onClose={onClose} onVs={onVs} />)
    fireEvent.click(findParent())
    const flyout = document.querySelector('.ctx-submenu')!
    expect(flyout).not.toBeNull()
    expect(findParent().getAttribute('aria-expanded')).toBe('true')
    const vsRow = [...flyout.querySelectorAll<HTMLButtonElement>('.ctx-menu-item')].find(
      (b) => b.querySelector('.ctx-menu-label')?.textContent === 'VS Code',
    )!
    fireEvent.click(vsRow)
    expect(onVs).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce() // the whole menu closes on leaf click
  })

  it('toggles the flyout closed on a second parent click', () => {
    render(<SubmenuHarness onClose={vi.fn()} onVs={vi.fn()} />)
    fireEvent.click(findParent())
    expect(document.querySelector('.ctx-submenu')).not.toBeNull()
    fireEvent.click(findParent())
    expect(document.querySelector('.ctx-submenu')).toBeNull()
  })

  it('opens on hover and closes when the pointer moves onto a plain row', () => {
    render(<SubmenuHarness onClose={vi.fn()} onVs={vi.fn()} />)
    fireEvent.mouseEnter(findParent())
    expect(document.querySelector('.ctx-submenu')).not.toBeNull()
    const plain = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu-item')].find(
      (b) => b.querySelector('.ctx-menu-label')?.textContent === 'Plain',
    )!
    fireEvent.mouseEnter(plain)
    expect(document.querySelector('.ctx-submenu')).toBeNull()
  })

  it('Escape unwinds the flyout first and only then closes the menu', () => {
    const onClose = vi.fn()
    render(<SubmenuHarness onClose={onClose} onVs={vi.fn()} />)
    fireEvent.click(findParent())
    expect(document.querySelector('.ctx-submenu')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('.ctx-submenu')).toBeNull()
    expect(onClose).not.toHaveBeenCalled() // menu survives the first Esc
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
