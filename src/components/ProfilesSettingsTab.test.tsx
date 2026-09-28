import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ProfilesSettingsTab } from './ProfilesSettingsTab'
import * as useProfiles from '../hooks/useProfiles'
import type { ProviderProfile } from '../types/config'

vi.mock('../hooks/useProfiles', () => ({ useProfiles: vi.fn() }))

// AnimatedCollapse (the fold animation) probes matchMedia/ResizeObserver,
// neither of which jsdom provides.
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})

afterEach(() => {
  cleanup()
})

const profiles: ProviderProfile[] = [
  {
    id: 'a',
    name: 'A',
    isActive: true,
    authTokenMasked: '****cdef',
    baseUrl: 'https://gw1',
    modelList: ['ma'],
    modelGroups: [],
    recapModel: 'r',
    commitMessageModel: 'c',
  },
  {
    id: 'b',
    name: 'B',
    isActive: false,
    authTokenMasked: undefined,
    baseUrl: 'https://gw2',
    modelList: ['mb'],
    modelGroups: [],
    recapModel: 'r',
    commitMessageModel: 'c',
  },
]

function mockUseProfiles() {
  vi.mocked(useProfiles.useProfiles).mockReturnValue({
    profiles,
    activeProfileId: 'a',
    refresh: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    activate: vi.fn(),
  })
}

describe('ProfilesSettingsTab', () => {
  /** The template dialog gates every "+ Add profile" flow. The dialog's own
   *  buttons must be scoped with `within` — the cards behind the modal also
   *  contain an "Add" button (the model-list row), which an unscoped query
   *  would happily hit and make the test pass for the wrong reason. */
  const openAddDialog = () => {
    fireEvent.click(screen.getByRole('button', { name: '+ Add profile' }))
    return screen.getByRole('dialog', { name: 'Add profile' })
  }
  const confirmAddDialog = () => {
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add profile' })).getByRole('button', { name: 'Add' }))
  }

  it('renders one card per profile with the active badge', () => {
    mockUseProfiles()
    render(<ProfilesSettingsTab />)
    expect(screen.getByText('A')).toBeTruthy()
    expect(screen.getByText('B')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
  })

  it('expands the active profile by default and folds to the clicked one', () => {
    mockUseProfiles()
    render(<ProfilesSettingsTab />)
    // Active profile A is expanded by default (its model 'ma' is rendered);
    // inactive profile B is folded (its model 'mb' is not in the document).
    expect(screen.queryAllByText('ma').length).toBeGreaterThan(0)
    expect(screen.queryAllByText('mb')).toHaveLength(0)
    // Clicking B's header toggles the accordion: A folds, B opens.
    fireEvent.click(screen.getByRole('button', { name: 'B' }))
    expect(screen.queryAllByText('mb').length).toBeGreaterThan(0)
    expect(screen.queryAllByText('ma')).toHaveLength(0)
  })

  describe('drag-reorder (dnd-kit)', () => {
    const multi: ProviderProfile[] = [
      {
        id: 'a',
        name: 'A',
        isActive: true,
        authTokenMasked: '****cdef',
        baseUrl: '',
        modelList: ['ma', 'mb', 'mc'],
        modelGroups: [
          { id: 'g1', name: 'Group 1', main: 'opus' },
          { id: 'g2', name: 'Group 2', main: 'sonnet' },
        ],
        recapModel: '',
        commitMessageModel: '',
      },
    ]

    function mockMulti() {
      const update = vi.fn().mockResolvedValue(undefined)
      vi.mocked(useProfiles.useProfiles).mockReturnValue({
        profiles: multi,
        activeProfileId: 'a',
        refresh: vi.fn(),
        create: vi.fn(),
        update,
        remove: vi.fn(),
        activate: vi.fn(),
      })
      return update
    }

    /** Give the sortable rows/cards real geometry — jsdom reports every rect
     *  as 0×0, which would collapse dnd-kit's closestCenter collision
     *  detection. Rows stack at 40px; group cards sit below at 200px+. */
    function primeRects(container: HTMLElement) {
      // Scope to the Available-Models list (the first .settings-model-list):
      // group cards contain their own .settings-model-row header.
      const list = container.querySelector<HTMLElement>('.settings-model-list')!
      list.querySelectorAll<HTMLElement>(':scope > .settings-model-row').forEach((el, i) => {
        el.getBoundingClientRect = () => rect(0, i * 40, 300, 38)
      })
      container.querySelectorAll<HTMLElement>('.settings-model-group').forEach((el, i) => {
        el.getBoundingClientRect = () => rect(0, 200 + i * 60, 300, 58)
      })
    }

    function rect(x: number, y: number, w: number, h: number): DOMRect {
      return {
        x, y, width: w, height: h,
        top: y, left: x, right: x + w, bottom: y + h,
        toJSON: () => ({}),
      } as DOMRect
    }

    /** Pointer-press the grip, drag `toY`, release. ≥5px of travel activates
     *  dnd-kit's PointerSensor (see dnd/sensors.ts). TWO moves: the first
     *  crosses the activation distance, but droppable rects are measured
     *  asynchronously (rAF) after activation — the second move is what
     *  collision detection sees with real geometry. On release, dnd-kit
     *  removes its document-level click stopper on a 50ms timer, so callers
     *  must await this before firing further clicks. */
    async function dragGripTo(grip: HTMLElement, toY: number) {
      fireEvent.pointerDown(grip, { pointerId: 1, button: 0, buttons: 1, isPrimary: true, clientX: 150, clientY: 20 })
      act(() => {
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientX: 150, clientY: toY })
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientX: 150, clientY: toY })
      })
      fireEvent.pointerUp(document, { pointerId: 1, buttons: 0 })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60))
      })
    }

    /** Model order, scoped to the list container — the DragOverlay ghost
     *  clone also renders a `.settings-model-row` and must not count. */
    const modelOrder = (container: HTMLElement) => {
      const list = container.querySelector<HTMLElement>('.settings-model-list')!
      return [...list.querySelectorAll<HTMLElement>(':scope > .settings-model-row > code')].map((el) => el.textContent)
    }

    /** Grip (rank badge) of each row in the Available-Models list, excluding
     *  the group cards' header rows. */
    const modelGrips = (container: HTMLElement) =>
      [...container.querySelectorAll<HTMLElement>('.settings-model-list > .settings-model-row > .settings-model-rank')]

    it('reorders model rows via drag (drop below → insert after)', async () => {
      mockMulti()
      const { container } = render(<ProfilesSettingsTab />)
      primeRects(container)
      // The rank badge is the drag grip; drag 'ma' (y≈20) down to 'mc' (y≈100).
      const grips = modelGrips(container)
      expect(grips.length).toBe(3)
      await dragGripTo(grips[0], 100)
      expect(modelOrder(container)).toEqual(['mb', 'mc', 'ma'])
    })

    it('ignores a no-op drag (item back onto its own slot) and stays clean', async () => {
      const update = mockMulti()
      const { container } = render(<ProfilesSettingsTab />)
      primeRects(container)
      const grips = modelGrips(container)
      // Drag 'ma' and release back over its own row — order must not change.
      await dragGripTo(grips[0], 10)
      expect(modelOrder(container)).toEqual(['ma', 'mb', 'mc'])
      fireEvent.click(screen.getByRole('button', { name: /^Save( changes)?$/i }))
      await vi.waitFor(() => {
        expect(update).toHaveBeenCalledWith(
          'a',
          expect.objectContaining({ modelList: ['ma', 'mb', 'mc'] }),
        )
      })
    })

    it('reorders model groups via the rank grip', async () => {
      mockMulti()
      const { container } = render(<ProfilesSettingsTab />)
      primeRects(container)
      const grips = [...container.querySelectorAll<HTMLElement>('.settings-model-group > .settings-model-row > .settings-model-rank')]
      expect(grips).toHaveLength(2)
      // Drag group 1's grip onto group 2's card → Group 2, Group 1. The drop
      // point is g2's centre: dnd-kit caches the ACTIVE node's rect at mount
      // (0×0 in jsdom — the stubs land after mount), so collision resolution
      // keys off the drop coordinates against the freshly-measured droppables.
      await dragGripTo(grips[0], 300)
      const names = [...container.querySelectorAll<HTMLInputElement>('.settings-model-group input[aria-label="Group name"]')]
        .map((el) => el.value)
      expect(names).toEqual(['Group 2', 'Group 1'])
    })

    it('marks the list dirty so Save flushes the new order', async () => {
      const update = mockMulti()
      const { container } = render(<ProfilesSettingsTab />)
      primeRects(container)
      const grips = modelGrips(container)
      await dragGripTo(grips[0], 100)
      expect(modelOrder(container)).toEqual(['mb', 'mc', 'ma'])
      // Unified Save in the modal calls the registered dirty callback, which
      // PUTs the profile. Click the card-level Save that appears when dirty.
      fireEvent.click(screen.getByRole('button', { name: /^Save( changes)?$/i }))
      await vi.waitFor(() => {
        expect(update).toHaveBeenCalledWith(
          'a',
          expect.objectContaining({ modelList: ['mb', 'mc', 'ma'] }),
        )
      })
    })

    it('exposes keyboard-sortable grips (a11y contract of dnd-kit)', () => {
      mockMulti()
      const { container } = render(<ProfilesSettingsTab />)
      const grips = modelGrips(container)
      expect(grips[0].getAttribute('aria-roledescription')).toBe('sortable')
      expect(grips[0].getAttribute('role')).toBe('button')
    })
  })

  describe('add profile focus', () => {
    const createdProfile: ProviderProfile = {
      id: 'new',
      name: 'New profile 3',
      isActive: false,
      authTokenMasked: undefined,
      baseUrl: '',
      modelList: [],
      modelGroups: [],
      recapModel: '',
      commitMessageModel: '',
    }

    function mockWithCreated() {
      const create = vi.fn().mockResolvedValue(createdProfile)
      vi.mocked(useProfiles.useProfiles).mockReturnValue({
        profiles: [...profiles, createdProfile],
        activeProfileId: 'a',
        refresh: vi.fn(),
        create,
        update: vi.fn(),
        remove: vi.fn(),
        activate: vi.fn(),
      })
      return create
    }

    // happy-dom implements scrollIntoView natively; the focus test replaces it
    // with a spy, and this puts the real method back so nothing leaks.
    const originalScrollIntoView = Element.prototype.scrollIntoView
    afterEach(() => {
      Element.prototype.scrollIntoView = originalScrollIntoView
    })

    it('expands the newly created card (collapsing the others) and focuses its Name input', async () => {
      mockWithCreated()
      const scrollIntoView = vi.fn()
      ;(Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView
      render(<ProfilesSettingsTab />)
      // Default state: the active card A is open, everything else folded.
      expect(screen.queryAllByText('ma').length).toBeGreaterThan(0)
      // The template dialog gates the create; the preselected active profile
      // is what the historic behavior used, so confirming unchanged works.
      openAddDialog()
      confirmAddDialog()
      const input = await vi.waitFor(() => {
        const el = document.querySelector<HTMLInputElement>('[data-profile-card="new"] [data-profile-name-input]')
        expect(el).not.toBeNull()
        expect(document.activeElement).toBe(el)
        return el!
      })
      // The default name is selected so typing replaces it outright.
      expect(input.selectionStart).toBe(0)
      expect(input.selectionEnd).toBe(input.value.length)
      // The fresh card scrolled into view…
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      expect(scrollIntoView.mock.instances[0]).toBe(input.closest('[data-profile-card="new"]'))
      // …and every other card folded.
      expect(screen.queryAllByText('ma')).toHaveLength(0)
      expect(screen.queryAllByText('mb')).toHaveLength(0)
    })

    it('guards against a double-click creating two profiles', async () => {
      // Never-resolving create: the request stays in flight for the whole test.
      const create = vi.fn(() => new Promise<ProviderProfile>(() => {}))
      vi.mocked(useProfiles.useProfiles).mockReturnValue({
        profiles,
        activeProfileId: 'a',
        refresh: vi.fn(),
        create,
        update: vi.fn(),
        remove: vi.fn(),
        activate: vi.fn(),
      })
      render(<ProfilesSettingsTab />)
      const add = screen.getByRole('button', { name: '+ Add profile' })
      // The template dialog gates the create; confirm starts it in flight and
      // the dialog STAYS OPEN (busy) until the create settles.
      openAddDialog()
      confirmAddDialog()
      const dialog = screen.getByRole('dialog', { name: 'Add profile' })
      const confirm = within(dialog).getByRole('button', { name: 'Adding...' }) as HTMLButtonElement
      expect(confirm.disabled).toBe(true)
      // jsdom still dispatches clicks to disabled buttons — the handler guard
      // is the real protection; disabled is the affordance.
      fireEvent.click(confirm)
      expect(create).toHaveBeenCalledTimes(1)
      expect((add as HTMLButtonElement).disabled).toBe(true)
    })

    it('keeps the dialog open with the error on a failed create, so the choice survives for a retry', async () => {
      const create = vi.fn().mockRejectedValue(new Error('profile not found'))
      vi.mocked(useProfiles.useProfiles).mockReturnValue({
        profiles,
        activeProfileId: 'a',
        refresh: vi.fn(),
        create,
        update: vi.fn(),
        remove: vi.fn(),
        activate: vi.fn(),
      })
      render(<ProfilesSettingsTab />)
      openAddDialog()
      confirmAddDialog()
      // Failure: the dialog must still be there, the server error shown
      // inside it — closing it would throw away the picked template.
      await vi.waitFor(() => {
        expect(within(screen.getByRole('dialog', { name: 'Add profile' })).getByText('profile not found')).toBeTruthy()
      })
    })

    it('does not show the previous attempt error when the dialog is reopened', async () => {
      const create = vi.fn()
        .mockRejectedValueOnce(new Error('stale error'))
        .mockResolvedValue(undefined)
      vi.mocked(useProfiles.useProfiles).mockReturnValue({
        profiles,
        activeProfileId: 'a',
        refresh: vi.fn(),
        create,
        update: vi.fn(),
        remove: vi.fn(),
        activate: vi.fn(),
      })
      render(<ProfilesSettingsTab />)
      // First attempt fails; the error shows in the dialog.
      openAddDialog()
      confirmAddDialog()
      await vi.waitFor(() => {
        expect(within(screen.getByRole('dialog', { name: 'Add profile' })).getByText('stale error')).toBeTruthy()
      })
      // Cancel, then reopen — the fresh dialog must not carry the old error.
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Add profile' })).getByRole('button', { name: 'Cancel' }))
      const dialog = openAddDialog()
      expect(within(dialog).queryByText('stale error')).toBeNull()
    })

    // NOTE: the pre-dialog test "accordion toggle during the in-flight create
    // wins over the focus hand-off" was removed with the takeover machinery:
    // the create only starts from the template dialog now, which holds a
    // full-viewport busy modal (Escape/backdrop blocked) for the whole
    // in-flight window, so nothing can toggle the accordion mid-create.

    it('does not fold every card when the created profile never lands (refresh failed)', async () => {
      // POST succeeds but the follow-up refresh never adds the card (its id is
      // absent from `profiles`): the accordion must fall back to the active
      // card instead of pinning a phantom and folding everything shut.
      const create = vi.fn().mockResolvedValue({ ...createdProfile, id: 'phantom' })
      vi.mocked(useProfiles.useProfiles).mockReturnValue({
        profiles,
        activeProfileId: 'a',
        refresh: vi.fn(),
        create,
        update: vi.fn(),
        remove: vi.fn(),
        activate: vi.fn(),
      })
      render(<ProfilesSettingsTab />)
      openAddDialog()
      confirmAddDialog()
      await vi.waitFor(() => {
        expect(create).toHaveBeenCalledTimes(1)
        expect(screen.queryAllByText('ma').length).toBeGreaterThan(0)
      })
    })

    it('drops the focus hand-off after 10s so a late-landing refresh cannot yank the UI', async () => {
      vi.useFakeTimers()
      try {
        let resolveCreate!: (p: ProviderProfile) => void
        const create = vi.fn(() => new Promise<ProviderProfile>((r) => { resolveCreate = r }))
        vi.mocked(useProfiles.useProfiles).mockReturnValue({
          profiles, // the card is NOT in the list — the follow-up refresh failed
          activeProfileId: 'a',
          refresh: vi.fn(),
          create,
          update: vi.fn(),
          remove: vi.fn(),
          activate: vi.fn(),
        })
        const { rerender } = render(<ProfilesSettingsTab />)
        openAddDialog()
        confirmAddDialog()
        await act(async () => {
          resolveCreate(createdProfile)
          await Promise.resolve()
        })
        // The hand-off expires before the card ever lands…
        vi.advanceTimersByTime(10_000)
        // …then a much later refresh finally lands it.
        vi.mocked(useProfiles.useProfiles).mockReturnValue({
          profiles: [...profiles, createdProfile],
          activeProfileId: 'a',
          refresh: vi.fn(),
          create,
          update: vi.fn(),
          remove: vi.fn(),
          activate: vi.fn(),
        })
        rerender(<ProfilesSettingsTab />)
        // The card joins folded — no accordion jump, no stolen focus.
        expect(screen.queryAllByText('ma').length).toBeGreaterThan(0)
        expect(document.querySelector('[data-profile-card="new"] [data-profile-name-input]')).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('add profile dialog', () => {
    it('opens the template dialog on + Add profile, preselected to the active profile', () => {
      mockUseProfiles()
      render(<ProfilesSettingsTab />)
      const dialog = openAddDialog()
      // The active profile is preselected — the historic default — and Blank
      // is offered alongside it.
      expect((within(dialog).getByRole('radio', { name: /^A / }) as HTMLInputElement).checked).toBe(true)
      expect((within(dialog).getByRole('radio', { name: /^Blank/ }) as HTMLInputElement).checked).toBe(false)
    })

    it('cancels without creating', () => {
      const create = vi.fn()
      vi.mocked(useProfiles.useProfiles).mockReturnValue({
        profiles,
        activeProfileId: 'a',
        refresh: vi.fn(),
        create,
        update: vi.fn(),
        remove: vi.fn(),
        activate: vi.fn(),
      })
      render(<ProfilesSettingsTab />)
      openAddDialog()
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Add profile' })).getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('dialog', { name: 'Add profile' })).toBeNull()
      expect(create).not.toHaveBeenCalled()
    })

    it('creates with template "blank" when Blank is picked and confirmed', async () => {
      const create = vi.fn().mockResolvedValue(undefined)
      vi.mocked(useProfiles.useProfiles).mockReturnValue({
        profiles,
        activeProfileId: 'a',
        refresh: vi.fn(),
        create,
        update: vi.fn(),
        remove: vi.fn(),
        activate: vi.fn(),
      })
      render(<ProfilesSettingsTab />)
      openAddDialog()
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Add profile' })).getByRole('radio', { name: /^Blank/ }))
      confirmAddDialog()
      await vi.waitFor(() => {
        expect(create).toHaveBeenCalledWith({ name: 'New profile 3', template: 'blank' })
      })
    })

    it('creates with the preselected active profile id when confirmed unchanged', async () => {
      const create = vi.fn().mockResolvedValue(undefined)
      vi.mocked(useProfiles.useProfiles).mockReturnValue({
        profiles,
        activeProfileId: 'a',
        refresh: vi.fn(),
        create,
        update: vi.fn(),
        remove: vi.fn(),
        activate: vi.fn(),
      })
      render(<ProfilesSettingsTab />)
      openAddDialog()
      confirmAddDialog()
      await vi.waitFor(() => {
        expect(create).toHaveBeenCalledWith({ name: 'New profile 3', template: 'a' })
      })
    })
  })

  describe('recap / commit model selects', () => {
    const stored: ProviderProfile[] = [
      {
        id: 'a',
        name: 'A',
        isActive: true,
        authTokenMasked: '****cdef',
        baseUrl: 'https://gw1',
        modelList: ['vendor/listed'],
        modelGroups: [],
        // Stored, but NOT in this profile's model list (e.g. carried over
        // from another subscription).
        recapModel: 'vendor/unlisted',
        commitMessageModel: '',
      },
    ]

    function mockStored() {
      const update = vi.fn().mockResolvedValue(undefined)
      vi.mocked(useProfiles.useProfiles).mockReturnValue({
        profiles: stored,
        activeProfileId: 'a',
        refresh: vi.fn(),
        create: vi.fn(),
        update,
        remove: vi.fn(),
        activate: vi.fn(),
      })
      return update
    }

    it('renders a stored model that is absent from the list, rather than blank', () => {
      mockStored()
      render(<ProfilesSettingsTab />)
      const select = screen.getByLabelText('Recap Model') as HTMLSelectElement
      // Without a matching <option> the select renders blank while still
      // holding a model id — the invisible state that hid this bug.
      expect(select.value).toBe('vendor/unlisted')
      expect(screen.getByRole('option', { name: /vendor\/unlisted/ })).toBeTruthy()
    })

    it('sends null when (default) is picked, so the server clears the stored model', async () => {
      const update = mockStored()
      render(<ProfilesSettingsTab />)
      fireEvent.change(screen.getByLabelText('Recap Model'), { target: { value: '' } })
      fireEvent.click(screen.getByRole('button', { name: /^Save( changes)?$/i }))
      await vi.waitFor(() => {
        expect(update).toHaveBeenCalledWith('a', expect.objectContaining({ recapModel: null }))
      })
    })
  })
})
