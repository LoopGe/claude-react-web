import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
