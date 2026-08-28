import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SessionProfileSelect } from './SessionProfileSelect'
import { api } from '../hooks/useApi'

vi.mock('../hooks/useProfiles', () => ({ useProfiles: () => ({
  profiles: [
    { id: 'a', name: 'A', isActive: true, baseUrl: '', modelList: [], modelGroups: [], recapModel: '', commitMessageModel: '' },
    { id: 'b', name: 'B', isActive: false, baseUrl: '', modelList: [], modelGroups: [], recapModel: '', commitMessageModel: '' },
  ],
  activeProfileId: 'a',
}) }))
vi.mock('../hooks/useApi', () => ({ api: { post: vi.fn() } }))

describe('SessionProfileSelect', () => {
  it('POSTs the chosen profile + apply mode', async () => {
    vi.mocked(api.post).mockResolvedValue({ session: { id: 's1', profileId: 'b' } })
    const onSessionUpdate = vi.fn()
    render(<SessionProfileSelect session={{ id: 's1', profileId: 'a' } as never} onSessionUpdate={onSessionUpdate} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } })
    fireEvent.click(screen.getByText('Restart now'))
    await vi.waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/sessions/s1/profile', { profileId: 'b', apply: 'now' })
    })
  })
})
