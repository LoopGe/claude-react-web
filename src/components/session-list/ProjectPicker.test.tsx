import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { ProjectPicker } from './ProjectPicker'
import { api } from '../../hooks/useApi'

vi.mock('../../hooks/useApi', () => ({ api: { get: vi.fn() } }))

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

const baseProps = () => ({
  value: '/work/proj',
  recents: ['/work/proj', '/other/repo'],
  onSelect: vi.fn(),
  onForget: vi.fn(),
  onBrowse: vi.fn(),
})

describe('ProjectPicker', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
    // Default: every directory exists.
    vi.mocked(api.get).mockResolvedValue({ cwd: '/work/proj', resolvedFromFile: false })
  })

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

  it('offers a pasted absolute path as a "Use this path" row', async () => {
    const props = setup()
    fireEvent.click(trigger())
    fireEvent.change(searchBox(), { target: { value: '/tmp/brand-new' } })
    const first = items()[0]
    expect(first.textContent).toContain('Use this path')
    expect(first.textContent).toContain('/tmp/brand-new')
    fireEvent.click(first)
    // Selection preflights the path when its verdict isn't known yet.
    await waitFor(() => expect(props.onSelect).toHaveBeenCalledWith('/tmp/brand-new'))
    expect(menu()).toBeNull()
  })

  it('selects a recent project and closes', async () => {
    const props = setup()
    fireEvent.click(trigger())
    fireEvent.click(items()[1])
    await waitFor(() => expect(props.onSelect).toHaveBeenCalledWith('/Users/loop/Codes/other'))
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

  it('moves the highlight with arrow keys and selects with Enter', async () => {
    const props = setup()
    fireEvent.click(trigger())
    const box = searchBox()
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(props.onSelect).toHaveBeenCalledWith('/Users/loop/Codes/other'))
  })

  it('composes the accessible label with the selected project', async () => {
    render(<ProjectPicker {...baseProps()} ariaLabel="Target project" />)
    const trigger = screen.getByRole('button', { name: /^Target project/ })
    // The label alone would hide the current install target from a screen
    // reader — the value has to be announced too.
    expect(trigger.getAttribute('aria-label')).toContain('Target project')
    expect(trigger.getAttribute('aria-label')).toContain('/work/proj')
  })

  it('closes the menu when it becomes disabled', async () => {
    const props = baseProps()
    const { rerender } = render(<ProjectPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Choose a project' })).toBeTruthy())

    rerender(<ProjectPicker {...props} disabled />)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose a project' })).toBeNull())
  })

  it('Enter on a menu button activates the button instead of choosing a row', async () => {
    const props = baseProps()
    render(<ProjectPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Open project/ })).toBeTruthy())

    const openProject = screen.getByRole('button', { name: /Open project/ })
    openProject.focus()
    // Native button activation needs the event NOT to be preventDefault'ed;
    // the old handler stole Enter to choose the highlighted row instead.
    const notPrevented = fireEvent.keyDown(openProject, { key: 'Enter' })
    expect(notPrevented).toBe(true)
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('only offers Forget for rows that are actually in the recents list', async () => {
    // The current value is always listed, even when it isn't a recent — a
    // Forget button there would be a no-op.
    render(<ProjectPicker {...baseProps()} recents={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    await waitFor(() => expect(screen.getByRole('listbox', { name: 'Projects' })).toBeTruthy())
    expect(screen.queryAllByLabelText(/^Forget /)).toHaveLength(0)
  })

  it('drops the Forget button once the current value is forgotten', async () => {
    const props = baseProps()
    const { rerender } = render(<ProjectPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    await waitFor(() => expect(screen.getByLabelText('Forget /work/proj')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Forget /work/proj'))
    expect(props.onForget).toHaveBeenCalledWith('/work/proj')

    // After the MRU write lands (recents no longer contains the value), the
    // row stays as the current value but the no-op Forget is gone.
    rerender(<ProjectPicker {...props} recents={['/other/repo']} />)
    expect(screen.queryByLabelText('Forget /work/proj')).toBeNull()
    expect(screen.getByRole('option', { name: /proj/ })).toBeTruthy()
  })

  it('arrow keys do not navigate while composing with an IME', async () => {
    render(<ProjectPicker {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search projects' })).toBeTruthy())

    const input = screen.getByRole('textbox', { name: 'Search projects' })
    const before = input.getAttribute('aria-activedescendant')
    fireEvent.keyDown(input, new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true }))
    expect(input.getAttribute('aria-activedescendant')).toBe(before)
    // Sanity: the same key outside composition does navigate.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).not.toBe(before)
  })

  it('marks a missing recent as unavailable but still forgettable', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.startsWith('/fs/resolve-cwd') && url.includes(encodeURIComponent('/other/repo'))) {
        return Promise.reject(Object.assign(new Error('no such path'), { status: 404 }))
      }
      return Promise.resolve({ cwd: '/work/proj' })
    })
    const props = baseProps()
    render(<ProjectPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))

    // The missing entry is disabled and labelled; the existing one is not.
    await waitFor(() => expect(screen.getByText('Directory not found')).toBeTruthy())
    expect((screen.getByRole('option', { name: /\/other/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('option', { name: /\/work/ }) as HTMLButtonElement).disabled).toBe(false)

    // ✕ still works so the dead entry can be dropped from recents.
    fireEvent.click(screen.getByLabelText('Forget /other/repo'))
    expect(props.onForget).toHaveBeenCalledWith('/other/repo')
  })

  it('does not disable rows when the existence check fails for other reasons', async () => {
    // A network/500 failure is not proof the directory is gone — never lock
    // the user out of their own projects on a flaky check.
    vi.mocked(api.get).mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }))
    render(<ProjectPicker {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    await waitFor(() => expect(screen.getByRole('listbox', { name: 'Projects' })).toBeTruthy())
    expect(screen.queryByText('Directory not found')).toBeNull()
    expect((screen.getByRole('option', { name: /\/other/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('Enter does not select a directory confirmed missing', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.startsWith('/fs/resolve-cwd') && url.includes(encodeURIComponent('/other/repo'))) {
        return Promise.reject(Object.assign(new Error('no such path'), { status: 404 }))
      }
      return Promise.resolve({ cwd: '/work/proj' })
    })
    const props = baseProps()
    render(<ProjectPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    await waitFor(() => expect(screen.getByText('Directory not found')).toBeTruthy())

    const input = screen.getByRole('textbox', { name: 'Search projects' })
    // Row 0 is the valid current value; ArrowDown lands on the missing row.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('treats a regular file at the project path as unavailable', async () => {
    // /fs/resolve-cwd succeeds for a FILE and hands back its parent — that is
    // not a project directory, so the row must still count as invalid.
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.startsWith('/fs/resolve-cwd') && url.includes(encodeURIComponent('/other/repo'))) {
        return Promise.resolve({ cwd: '/other', resolvedFromFile: true })
      }
      return Promise.resolve({ cwd: '/work/proj', resolvedFromFile: false })
    })
    render(<ProjectPicker {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    await waitFor(() => expect(screen.getByText('Directory not found')).toBeTruthy())
    expect((screen.getByRole('option', { name: /\/other/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('validates the typed Use this path entry before allowing it', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.startsWith('/fs/resolve-cwd') && url.includes(encodeURIComponent('/tmp/typo-project'))) {
        return Promise.reject(Object.assign(new Error('no such path'), { status: 404 }))
      }
      return Promise.resolve({ cwd: '/work/proj', resolvedFromFile: false })
    })
    const props = baseProps()
    render(<ProjectPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    const input = await screen.findByRole('textbox', { name: 'Search projects' })
    fireEvent.change(input, { target: { value: '/tmp/typo-project' } })

    // The typed row is checked too (debounced), and Enter on it is blocked.
    await waitFor(() => expect(screen.getByText('Directory not found')).toBeTruthy())
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('does not revalidate the whole list when recents change', async () => {
    const props = baseProps()
    const { rerender } = render(<ProjectPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.filter(([u]) => String(u).startsWith('/fs/resolve-cwd'))).toHaveLength(2))

    // Forgetting one entry must not restart the batch for the others.
    rerender(<ProjectPicker {...props} recents={['/work/proj']} />)
    await new Promise((r) => setTimeout(r, 0))
    expect(vi.mocked(api.get).mock.calls.filter(([u]) => String(u).startsWith('/fs/resolve-cwd'))).toHaveLength(2)
  })

  it('uses the project overlay scrollbar for the menu list', async () => {
    // Same attach as ModelPicker: the custom overlay thumb replaces the
    // native scrollbar on the menu's list container.
    render(<ProjectPicker {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    await waitFor(() => expect(document.querySelector('.project-picker-menu .os-track')).toBeTruthy())
  })

  it('a pending validation still lands when recents change mid-flight', async () => {
    // Forgetting one entry must not abort a different entry's pending check
    // and then skip re-requesting it for the rest of the session.
    let resolveWork!: (v: unknown) => void
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.startsWith('/fs/resolve-cwd') && url.includes(encodeURIComponent('/work/proj'))) {
        return new Promise((resolve) => { resolveWork = resolve })
      }
      if (url.startsWith('/fs/resolve-cwd') && url.includes(encodeURIComponent('/other/repo'))) {
        return Promise.reject(Object.assign(new Error('no such path'), { status: 404 }))
      }
      return Promise.resolve({ cwd: '/x', resolvedFromFile: false })
    })
    const props = baseProps()
    const { rerender } = render(<ProjectPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    await waitFor(() => expect(screen.getByText('Directory not found')).toBeTruthy())

    // Forget the other entry while /work/proj's check is still pending…
    rerender(<ProjectPicker {...props} recents={['/work/proj']} />)
    // …then let it land as missing: the current value must be marked too.
    resolveWork(Promise.reject(Object.assign(new Error('no such path'), { status: 404 })))
    await waitFor(() => expect((screen.getByRole('option', { name: /\/work/ }) as HTMLButtonElement).disabled).toBe(true))
  })

  it('a later failed revalidation clears a stale missing flag (fail-open)', async () => {
    // First open: /other/repo is confirmed gone. Second open: the check now
    // fails with a 500 — that is not proof it is still gone, so the row must
    // become selectable again rather than stay locked out.
    let failWith404 = true
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.startsWith('/fs/resolve-cwd') && url.includes(encodeURIComponent('/other/repo'))) {
        return failWith404
          ? Promise.reject(Object.assign(new Error('no such path'), { status: 404 }))
          : Promise.reject(Object.assign(new Error('boom'), { status: 500 }))
      }
      return Promise.resolve({ cwd: '/work/proj', resolvedFromFile: false })
    })
    render(<ProjectPicker {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    await waitFor(() => expect(screen.getByText('Directory not found')).toBeTruthy())

    failWith404 = false
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose a project' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    await waitFor(() => expect(screen.queryByText('Directory not found')).toBeNull())
    expect((screen.getByRole('option', { name: /\/other/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('selecting before validation completes preflights the path', async () => {
    // Clicking a recent before its verdict lands must not slip a deleted
    // project through — choose() re-checks unknown paths before selecting.
    let resolveCheck!: (v: unknown) => void
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.startsWith('/fs/resolve-cwd') && url.includes(encodeURIComponent('/other/repo'))) {
        return new Promise((resolve) => { resolveCheck = resolve })
      }
      return Promise.resolve({ cwd: '/work/proj', resolvedFromFile: false })
    })
    const props = baseProps()
    render(<ProjectPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    await waitFor(() => expect(screen.getByRole('option', { name: /\/other/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('option', { name: /\/other/ }))
    expect(props.onSelect).not.toHaveBeenCalled()

    resolveCheck({ cwd: '/other/repo', resolvedFromFile: false })
    await waitFor(() => expect(props.onSelect).toHaveBeenCalledWith('/other/repo'))
  })

  it('a stale concurrent response cannot overwrite a newer verdict', async () => {
    // The open-session effect and the typed-path effect can check the SAME
    // path. An older 200 arriving after a newer 404 must not re-enable it.
    let resolveOlder!: (v: unknown) => void
    let calls = 0
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.startsWith('/fs/resolve-cwd') && url.includes(encodeURIComponent('/other/repo'))) {
        calls += 1
        if (calls === 1) return new Promise((resolve) => { resolveOlder = resolve })
        return Promise.reject(Object.assign(new Error('no such path'), { status: 404 }))
      }
      return Promise.resolve({ cwd: '/work/proj', resolvedFromFile: false })
    })
    const props = baseProps()
    render(<ProjectPicker {...props} value="/work/proj" recents={['/other/repo']} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    const input = await screen.findByRole('textbox', { name: 'Search projects' })
    // The typed row re-checks /other/repo and returns 404 first…
    fireEvent.change(input, { target: { value: '/other/repo' } })
    await waitFor(() => expect(screen.getAllByText('Directory not found').length).toBeGreaterThan(0))
    // …then the OLDER 200 lands: the 404 verdict must win.
    resolveOlder({ cwd: '/other/repo', resolvedFromFile: false })
    await new Promise((r) => setTimeout(r, 0))
    const rows = screen.getAllByRole('option', { name: /\/other/ }) as HTMLButtonElement[]
    expect(rows.every((el) => el.disabled)).toBe(true)
  })

  it('closing the picker clears missing verdicts for the next open', async () => {
    // Otherwise a directory recreated between opens stays disabled under a
    // stale 404 while the fresh check is still in flight.
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.startsWith('/fs/resolve-cwd') && url.includes(encodeURIComponent('/other/repo'))) {
        return Promise.reject(Object.assign(new Error('no such path'), { status: 404 }))
      }
      return Promise.resolve({ cwd: '/work/proj', resolvedFromFile: false })
    })
    render(<ProjectPicker {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    await waitFor(() => expect(screen.getByText('Directory not found')).toBeTruthy())

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose a project' })).toBeNull())
    // Recreate it: next open must not show the stale verdict at all.
    vi.mocked(api.get).mockResolvedValue({ cwd: '/work/proj', resolvedFromFile: false })
    fireEvent.click(screen.getByRole('button', { name: /proj/ }))
    expect(screen.queryByText('Directory not found')).toBeNull()
  })
})
