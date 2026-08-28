import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProfileSwitcher } from './ProfileSwitcher'
import * as useProfiles from '../hooks/useProfiles'

vi.mock('../hooks/useProfiles', () => ({ useProfiles: vi.fn() }))

describe('ProfileSwitcher', () => {
  it('shows the active profile name and activates on select', () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    vi.mocked(useProfiles.useProfiles).mockReturnValue({
      profiles: [
        { id: 'a', name: 'A', isActive: true, baseUrl: '', modelList: [], modelGroups: [], recapModel: '', commitMessageModel: '' },
        { id: 'b', name: 'B', isActive: false, baseUrl: '', modelList: [], modelGroups: [], recapModel: '', commitMessageModel: '' },
      ],
      activeProfileId: 'a', refresh: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), activate,
    })
    render(<ProfileSwitcher />)
    expect(screen.getByText('A')).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('B'))
    expect(activate).toHaveBeenCalledWith('b')
  })
})
