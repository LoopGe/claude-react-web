// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

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
    const { container } = render(
      <ContextMenu x={0} y={0} items={items} onClose={() => {}} />,
    )
    const seps = container.querySelectorAll('.ctx-menu-sep')
    expect(seps.length).toBe(1)
    const labels = Array.from(container.querySelectorAll('.ctx-menu-label')).map((e) => e.textContent)
    expect(labels).toEqual(['A', 'B'])
  })

  it('trims leading and trailing separators', () => {
    const items: ContextMenuItem[] = [
      { label: '' },
      { label: 'A', onClick: () => {} },
      { label: '' },
    ]
    const { container } = render(
      <ContextMenu x={0} y={0} items={items} onClose={() => {}} />,
    )
    expect(container.querySelectorAll('.ctx-menu-sep').length).toBe(0)
    expect(container.querySelectorAll('.ctx-menu-label').length).toBe(1)
  })

  it('keeps a single separator between two real items', () => {
    const items: ContextMenuItem[] = [
      { label: 'A', onClick: () => {} },
      { label: '' },
      { label: 'B', onClick: () => {} },
    ]
    const { container } = render(
      <ContextMenu x={0} y={0} items={items} onClose={() => {}} />,
    )
    expect(container.querySelectorAll('.ctx-menu-sep').length).toBe(1)
  })

  it('fires onClick then onClose when a real item is clicked', () => {
    const onItem = vi.fn()
    const onClose = vi.fn()
    const items: ContextMenuItem[] = [{ label: 'Run', onClick: onItem }]
    const { container } = render(
      <ContextMenu x={0} y={0} items={items} onClose={onClose} />,
    )
    fireEvent.click(container.querySelector('.ctx-menu-item')!)
    expect(onItem).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })
})
