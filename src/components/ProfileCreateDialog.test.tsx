// @vitest-environment jsdom
// NOTE: no per-file afterEach(cleanup) — src/test-setup.ts already registers
// the global one (see CLAUDE.md); re-adding it here is redundant.
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { ProfileCreateDialog } from './ProfileCreateDialog'
import { expectPortaledToBody } from './portal-test-utils'
import type { ProviderProfile } from '../types/config'

function profile(id: string, overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id,
    name: id,
    authTokenMasked: undefined,
    baseUrl: 'https://api.anthropic.com',
    modelList: ['m1'],
    modelGroups: [],
    recapModel: '',
    commitMessageModel: '',
    isActive: false,
    ...overrides,
  }
}

const twoProfiles = [
  profile('default', { name: 'Gateway', isActive: true, baseUrl: 'https://gw.example' }),
  profile('p_two', { name: 'Second', baseUrl: 'https://gw2.example' }),
]

function baseProps(overrides: Partial<React.ComponentProps<typeof ProfileCreateDialog>> = {}) {
  return {
    profiles: twoProfiles,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
}

describe('ProfileCreateDialog', () => {
  it('lists Blank and every profile, with the active profile preselected', () => {
    const { getByRole, getByLabelText } = render(<ProfileCreateDialog {...baseProps()} />)
    expect(getByRole('dialog', { name: 'Add profile' })).toBeTruthy()
    expect(getByLabelText(/Blank/)).toBeTruthy()
    expect(getByLabelText(/Gateway/)).toBeTruthy()
    expect(getByLabelText(/Second/)).toBeTruthy()
    // The historic behavior (template from active) stays one Enter away.
    expect((getByLabelText(/Gateway/) as HTMLInputElement).checked).toBe(true)
    expect((getByLabelText(/Blank/) as HTMLInputElement).checked).toBe(false)
  })

  it('preselects Blank when no profile is active', () => {
    const profiles = [profile('a', { name: 'A' }), profile('b', { name: 'B' })]
    const { getByLabelText } = render(<ProfileCreateDialog {...baseProps({ profiles })} />)
    expect((getByLabelText(/Blank/) as HTMLInputElement).checked).toBe(true)
  })

  it('re-derives the preselection when the profiles snapshot lands after mount', () => {
    // The dialog can open before the tab's initial GET /profiles resolves:
    // mounted with an empty list it must show Blank, then follow the newly
    // arrived active profile without any user interaction.
    const props = baseProps({ profiles: [] })
    const { getByLabelText, rerender } = render(<ProfileCreateDialog {...props} />)
    expect((getByLabelText(/Blank/) as HTMLInputElement).checked).toBe(true)
    rerender(<ProfileCreateDialog {...props} profiles={twoProfiles} />)
    expect((getByLabelText(/Gateway/) as HTMLInputElement).checked).toBe(true)
    expect((getByLabelText(/Blank/) as HTMLInputElement).checked).toBe(false)
  })

  it('keeps an explicit choice once made, even when the profiles list changes', () => {
    const props = baseProps()
    const { getByLabelText, rerender } = render(<ProfileCreateDialog {...props} />)
    // Explicitly pick Blank while Gateway is auto-selected. (Clicking an
    // already-checked radio fires no change event, so the explicit pick has
    // to differ from the auto one.)
    fireEvent.click(getByLabelText(/Blank/))
    // The list changes underneath (e.g. another tab switched the active
    // profile) — auto would now point at Second, but the explicit pick wins.
    const next = [
      profile('default', { name: 'Gateway', baseUrl: 'https://gw.example' }),
      profile('p_two', { name: 'Second', isActive: true, baseUrl: 'https://gw2.example' }),
    ]
    rerender(<ProfileCreateDialog {...props} profiles={next} />)
    expect((getByLabelText(/Blank/) as HTMLInputElement).checked).toBe(true)
    expect((getByLabelText(/Second/) as HTMLInputElement).checked).toBe(false)
  })

  it('confirms with the preselected active profile id without any interaction', () => {
    const props = baseProps()
    const { getByText } = render(<ProfileCreateDialog {...props} />)
    fireEvent.click(getByText('Add'))
    expect(props.onConfirm).toHaveBeenCalledWith('default')
  })

  it('confirms with the chosen template — Blank or a named profile', () => {
    const props = baseProps()
    const { getByLabelText, getByText } = render(<ProfileCreateDialog {...props} />)
    fireEvent.click(getByLabelText(/Blank/))
    fireEvent.click(getByText('Add'))
    expect(props.onConfirm).toHaveBeenCalledWith('blank')

    fireEvent.click(getByLabelText(/Second/))
    fireEvent.click(getByText('Add'))
    expect(props.onConfirm).toHaveBeenCalledWith('p_two')
  })

  it('calls onCancel via Escape and the Cancel button', () => {
    const props = baseProps()
    const { getByText } = render(<ProfileCreateDialog {...props} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(props.onCancel).toHaveBeenCalledOnce()
    fireEvent.click(getByText('Cancel'))
    expect(props.onCancel).toHaveBeenCalledTimes(2)
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('never checks two radios at once when the ACTIVE profile has a reserved id', () => {
    // Hand-edited config.json can even make the ACTIVE profile's id 'blank'.
    // The preselection must then fall to the Blank keyword row WITHOUT also
    // checking the reserved profile's row (a radio group with two checked
    // inputs renders as whichever the browser saw last, and confirm would
    // send a template the user cannot tell from the UI).
    const profiles = [
      profile('blank', { name: 'Blanky', isActive: true, baseUrl: 'https://blanky.example' }),
      profile('p_two', { name: 'Second', baseUrl: 'https://gw2.example' }),
    ]
    const props = baseProps({ profiles })
    const { getByText, getByLabelText } = render(<ProfileCreateDialog {...props} />)
    // The Blank row's accessible name is the title+hint text run together,
    // so the keyword row is disambiguated by its unique hint text here.
    expect((getByLabelText(/Built-in defaults/) as HTMLInputElement).checked).toBe(true)
    expect((getByLabelText(/^Blanky/) as HTMLInputElement).checked).toBe(false)
    // Confirming still sends the Blank keyword — the only thing 'blank'
    // can mean.
    fireEvent.click(getByText('Add'))
    expect(props.onConfirm).toHaveBeenCalledWith('blank')
  })

  it('disables the radio of a profile whose id collides with a reserved template keyword', () => {
    // Hand-edited config.json can hold id 'blank' / 'active'. The server
    // resolves template:'blank' to the KEYWORD, so offering that profile as
    // an ordinary selectable radio would create something the user did not
    // pick. It stays listed (it exists), but not selectable.
    const profiles = [
      ...twoProfiles,
      profile('blank', { name: 'Blanky', baseUrl: 'https://blanky.example' }),
      profile('active', { name: 'Actively', baseUrl: 'https://actively.example' }),
    ]
    const { getByLabelText } = render(<ProfileCreateDialog {...baseProps({ profiles })} />)
    const blanky = getByLabelText(/^Blanky/) as HTMLInputElement
    const actively = getByLabelText(/^Actively/) as HTMLInputElement
    expect(blanky.disabled).toBe(true)
    expect(actively.disabled).toBe(true)
    // The reason is discoverable in the row's title.
    expect(blanky.closest('label')?.getAttribute('title')).toMatch(/reserved/)
  })

  it('shows the Adding... label and disables everything while busy', () => {
    const props = baseProps()
    const { getByText, getByLabelText, getByRole } = render(<ProfileCreateDialog {...props} busy />)
    expect((getByText('Adding...') as HTMLButtonElement).disabled).toBe(true)
    expect((getByText('Cancel') as HTMLButtonElement).disabled).toBe(true)
    expect((getByLabelText(/Blank/) as HTMLInputElement).disabled).toBe(true)
    // Escape must not cancel while the create is in flight.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(getByRole('dialog', { name: 'Add profile' })).toBeTruthy()
  })

  it('renders a server-provided error inside the dialog', () => {
    const { getByText, getByRole } = render(<ProfileCreateDialog {...baseProps({ error: 'profile not found' })} />)
    expect(getByRole('dialog', { name: 'Add profile' })).toBeTruthy()
    expect(getByText('profile not found')).toBeTruthy()
  })

  // Same containment hazard as ProfileActivateDialog: the settings tab is an
  // absolutely-positioned overlay world, so the modal variant's <body> portal
  // is load-bearing. Pin both the portal and the layout-pinning card class.
  it('portals to <body> with the layout-pinning card class', () => {
    const { container } = render(<ProfileCreateDialog {...baseProps()} />)
    expectPortaledToBody(container, '.modal-backdrop')
    expect(document.querySelector('.modal.profile-create-card')).not.toBeNull()
  })

  // Sanity guard for the test file itself: screen queries below must see the
  // portaled dialog (screen is document.body-scoped).
  it('is reachable through screen queries', () => {
    render(<ProfileCreateDialog {...baseProps()} />)
    expect(screen.getByRole('dialog', { name: 'Add profile' })).toBeTruthy()
  })
})
