import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { ProjectPicker } from './ProjectPicker'

afterEach(() => cleanup())

const RECENTS = ['/Users/loop/Codes/app', '/Users/loop/Codes/other']

function setup(overrides: Partial<ComponentProps<typeof ProjectPicker>> = {}) {
  const props: ComponentProps<typeof ProjectPicker> = {
    id: 'proj',
    value: RECENTS[0],
    recents: RECENTS,
    onSelect: vi.fn(),
    onForget: vi.fn(),
    onBrowse: vi.fn(),
    ...overrides,
  }
  render(<ProjectPicker {...props} />)
  return props
}

const trigger = () => document.querySelector('.project-picker-trigger') as HTMLButtonElement
const menu = () => document.querySelector('.project-picker-menu')
const items = () => Array.from(document.querySelectorAll('.project-picker-item')) as HTMLButtonElement[]
const searchBox = () => screen.getByRole('textbox', { name: 'Search projects' })

describe('ProjectPicker', () => {
  it('renders the selected project name + parent path on the trigger', () => {
    setup()
    expect(trigger().textContent).toContain('app')
    expect(trigger().textContent).toContain('/Users/loop/Codes')
  })

  it('shows a placeholder when no project is selected', () => {
    setup({ value: '' })
    expect(trigger().textContent).toContain('Choose a project')
  })

  it('opens the menu listing the current value first, then the recents', () => {
    setup()
    expect(menu()).toBeNull()
    fireEvent.click(trigger())
    expect(menu()).toBeTruthy()
    expect(items().map((el) => el.textContent)).toEqual([
      expect.stringContaining('app'),
      expect.stringContaining('other'),
    ])
  })

  it('filters the list by name', () => {
    setup()
    fireEvent.click(trigger())
    fireEvent.change(searchBox(), { target: { value: 'other' } })
    expect(items()).toHaveLength(1)
    expect(items()[0].textContent).toContain('other')
  })

  it('offers a pasted absolute path as a "Use this path" row', () => {
    const props = setup()
    fireEvent.click(trigger())
    fireEvent.change(searchBox(), { target: { value: '/tmp/brand-new' } })
    const first = items()[0]
    expect(first.textContent).toContain('Use this path')
    expect(first.textContent).toContain('/tmp/brand-new')
    fireEvent.click(first)
    expect(props.onSelect).toHaveBeenCalledWith('/tmp/brand-new')
    expect(menu()).toBeNull()
  })

  it('selects a recent project and closes', () => {
    const props = setup()
    fireEvent.click(trigger())
    fireEvent.click(items()[1])
    expect(props.onSelect).toHaveBeenCalledWith('/Users/loop/Codes/other')
    expect(menu()).toBeNull()
  })

  it('forgets an entry without selecting it', () => {
    const props = setup()
    fireEvent.click(trigger())
    const forgetButtons = document.querySelectorAll('.project-picker-forget')
    fireEvent.click(forgetButtons[1])
    expect(props.onForget).toHaveBeenCalledWith('/Users/loop/Codes/other')
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    setup()
    fireEvent.click(trigger())
    fireEvent.keyDown(searchBox(), { key: 'Escape' })
    expect(menu()).toBeNull()
  })

  it('stays open when focus drops to nothing (Safari blurs the search box on button mousedown)', () => {
    setup()
    fireEvent.click(trigger())
    fireEvent.focusOut(searchBox(), { relatedTarget: null })
    expect(menu()).toBeTruthy()
  })

  it('closes when focus moves to a control outside the menu', () => {
    setup()
    fireEvent.click(trigger())
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    fireEvent.focusOut(searchBox(), { relatedTarget: outside })
    expect(menu()).toBeNull()
    outside.remove()
  })

  it('browses the server directories from the footer action', () => {
    const props = setup()
    fireEvent.click(trigger())
    fireEvent.click(screen.getByText('Open project…'))
    expect(props.onBrowse).toHaveBeenCalled()
    expect(menu()).toBeNull()
  })

  it('moves the highlight with arrow keys and selects with Enter', () => {
    const props = setup()
    fireEvent.click(trigger())
    const box = searchBox()
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(props.onSelect).toHaveBeenCalledWith('/Users/loop/Codes/other')
  })
})
