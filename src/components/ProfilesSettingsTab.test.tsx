import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
})
