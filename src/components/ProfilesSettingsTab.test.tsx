import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProfilesSettingsTab } from './ProfilesSettingsTab'
import * as useProfiles from '../hooks/useProfiles'
import type { ProviderProfile } from '../types/config'

/** Minimal DataTransfer stand-in. jsdom has no HTML5 DnD, and
 *  `isInAppDrag` / `readDragPayload` both go through `types` + custom
 *  MIME — so the mock has to keep `types` in sync with `setData`. */
function makeDataTransfer() {
  const store = new Map<string, string>()
  const types: string[] = []
  return {
    effectAllowed: 'none' as string,
    get types() {
      return types.slice()
    },
    setData(type: string, value: string) {
      if (!store.has(type)) types.push(type)
      store.set(type, value)
    },
    getData(type: string) {
      return store.get(type) ?? ''
    },
  }
}

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

  describe('drag-reorder', () => {
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

    function dragOnto(source: HTMLElement, target: HTMLElement) {
      // jsdom's DragEvent does not forward `clientY` into the React synthetic
      // event (`undefined < midpoint` is false), so every drop reads as
      // 'after'. That is enough to prove the reorder wiring end-to-end; the
      // 'before' branch is the same ternary with the comparison flipped and
      // isn't expressible here. Use fireEvent (native dispatchEvent does not
      // reach React's delegated handlers in this setup).
      const dt = makeDataTransfer()
      fireEvent.dragStart(source, { dataTransfer: dt })
      fireEvent.dragOver(target, { dataTransfer: dt })
      fireEvent.drop(target, { dataTransfer: dt })
    }

    it('reorders model rows via drag (drop below → insert after)', () => {
      mockMulti()
      render(<ProfilesSettingsTab />)
      // The rank badge is the drag grip; the row is the drop target.
      const rows = screen.getAllByRole('code').map((el) => el.closest<HTMLElement>('.settings-model-row')!)
      const grips = rows.map((r) => r.querySelector<HTMLElement>('.settings-model-rank')!)
      // Drag 'ma' below 'mc' → mb, mc, ma.
      dragOnto(grips[0], rows[2])
      const order = screen.getAllByRole('code').map((el) => el.textContent)
      expect(order).toEqual(['mb', 'mc', 'ma'])
    })

    it('ignores a no-op drop (item onto its own row) and stays clean', async () => {
      const update = mockMulti()
      render(<ProfilesSettingsTab />)
      const rows = screen.getAllByRole('code').map((el) => el.closest<HTMLElement>('.settings-model-row')!)
      const grips = rows.map((r) => r.querySelector<HTMLElement>('.settings-model-rank')!)
      // Drop 'ma' onto its own row — order must not change.
      dragOnto(grips[0], rows[0])
      const order = screen.getAllByRole('code').map((el) => el.textContent)
      expect(order).toEqual(['ma', 'mb', 'mc'])
      // Save still PUTs the unchanged list (applyReorder short-circuited, so
      // no shuffle leaked into state).
      fireEvent.click(screen.getByRole('button', { name: /^Save( changes)?$/i }))
      await vi.waitFor(() => {
        expect(update).toHaveBeenCalledWith(
          'a',
          expect.objectContaining({ modelList: ['ma', 'mb', 'mc'] }),
        )
      })
    })

    it('reorders model groups via the rank grip', () => {
      mockMulti()
      const { container } = render(<ProfilesSettingsTab />)
      const grips = container.querySelectorAll<HTMLElement>('.settings-model-group .settings-model-rank')
      const groups = container.querySelectorAll<HTMLElement>('.settings-model-group')
      expect(grips).toHaveLength(2)
      // Drag group 1's grip onto group 2's card → Group 2, Group 1.
      dragOnto(grips[0], groups[1])
      const names = [...container.querySelectorAll<HTMLInputElement>('.settings-model-group input[aria-label="Group name"]')]
        .map((el) => el.value)
      expect(names).toEqual(['Group 2', 'Group 1'])
    })

    it('marks the list dirty so Save flushes the new order', async () => {
      const update = mockMulti()
      render(<ProfilesSettingsTab />)
      const rows = screen.getAllByRole('code').map((el) => el.closest<HTMLElement>('.settings-model-row')!)
      const grips = rows.map((r) => r.querySelector<HTMLElement>('.settings-model-rank')!)
      dragOnto(grips[0], rows[2])
      // Unified Save in the modal calls the registered dirty callback, which
      // PUTs the profile. Click the card-level Save that appears when dirty.
      const saveBtn = screen.getByRole('button', { name: /^Save( changes)?$/i })
      fireEvent.click(saveBtn)
      await vi.waitFor(() => {
        expect(update).toHaveBeenCalledWith(
          'a',
          expect.objectContaining({ modelList: ['mb', 'mc', 'ma'] }),
        )
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
