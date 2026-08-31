import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProfilesSettingsTab } from './ProfilesSettingsTab'
import * as useProfiles from '../hooks/useProfiles'

vi.mock('../hooks/useProfiles', () => ({ useProfiles: vi.fn() }))

describe('ProfilesSettingsTab', () => {
  it('renders one card per profile with the active badge', () => {
    vi.mocked(useProfiles.useProfiles).mockReturnValue({
      profiles: [
        { id: 'a', name: 'A', isActive: true, authTokenMasked: '****cdef', baseUrl: 'https://gw1', modelList: ['ma'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' },
        { id: 'b', name: 'B', isActive: false, authTokenMasked: undefined, baseUrl: 'https://gw2', modelList: ['mb'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' },
      ],
      activeProfileId: 'a', refresh: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), activate: vi.fn(),
    })
    render(<ProfilesSettingsTab />)
    expect(screen.getByText('A')).toBeTruthy()
    expect(screen.getByText('B')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
  })
})
