// Staged appearance state contract for GlobalSettingsModal.
//
// These tests pin down the behaviour the refactor must preserve when the ten
// split appearance useState calls collapse into one staged `AppearancePrefs`
// object + `patchAppearance`. They go through the modal's public UI (render +
// interact + Save) so they guard the contract without coupling to internal
// state shape: every assertion is observable from the wire payload or the
// rendered control state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastProvider } from './ToastProvider'
import { GlobalSettingsModal } from './GlobalSettingsModal'
import { api } from '../hooks/useApi'
import { mockGet } from '../test-utils/settings-fixtures'
import type { AppearancePrefs } from '../types/config'

vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }))

// happy-dom does not implement matchMedia; the modal's height-transition and
// exit-presence hooks probe it. Same stub as GlobalSettingsModal.test.tsx.
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))

afterEach(() => { cleanup() })

/** Every appearance field, asserted as a unit so a dropped field can't hide
 *  behind a sample. Excludes `firstPartyTools` (independent save path). */
const APPEARANCE_FIELDS: ReadonlyArray<keyof AppearancePrefs> = [
  'showPinnedUserMessage',
  'autoRecap',
  'toolGroupCards',
  'autoExpandRunningGroups',
  'showMessageHeaders',
  'rowGap',
  'textSpacing',
  'fontSize',
  'animationSpeed',
  'streamingRenderMode',
]

/** A config where EVERY appearance field is a non-default value — explicit
 *  false on every boolean, non-default presets, inline streaming. A coincidental
 *  default can't hide a dropped mapping or a patch that clobbers neighbours. */
const ALL_NON_DEFAULT: Record<string, unknown> = {
  showPinnedUserMessage: false,
  autoRecap: false,
  toolGroupCards: false,
  autoExpandRunningGroups: false,
  showMessageHeaders: false,
  rowGap: 'comfortable',
  textSpacing: 'compact',
  fontSize: 'large',
  animationSpeed: 'fast',
  streamingRenderMode: 'inline',
}

describe('GlobalSettingsModal staged appearance state', () => {
  beforeEach(() => {
    vi.mocked(api.put).mockResolvedValue({})
    // mockResolvedValue only sets an implementation — it does NOT clear the
    // call history. Without this, a later `waitFor(api.put).toHaveBeenCalled()`
    // is satisfied instantly by an earlier test's PUT.
    vi.mocked(api.put).mockClear()
  })

  const openAppearanceTab = async (
    config: Record<string, unknown> = {},
    overrides: { onClose?: () => void } = {},
  ) => {
    mockGet(config)
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={overrides.onClose ?? (() => {})} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Appearance' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    // Content is gated on the /config/full fetch — wait for an Appearance-only
    // control so a slow resolve can't race the first assertion.
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Font size' })).toBeTruthy())
  }

  const save = () => fireEvent.click(screen.getByText('Save'))

  /** The PUT /config body the Save fired. Throws if Save hasn't fired yet. */
  const savedPayload = async (): Promise<Record<string, unknown>> => {
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    const [, body] = vi.mocked(api.put).mock.calls[0]!
    return body as Record<string, unknown>
  }

  // ── Initialization ──────────────────────────────────────────────────

  it('initializes every appearance field from /config/full, preserving explicit false', async () => {
    await openAppearanceTab(ALL_NON_DEFAULT)

    // Every boolean switch reflects the explicit false from config, not the
    // useState(true) initial state.
    expect(screen.getByRole('switch', { name: 'Show pinned “current question” header' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Auto-generate session recap' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Use collapsible transcript cards' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Show message card headers' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Render live text inline in the transcript' }).getAttribute('aria-checked')).toBe('true')
  })

  it('falls back to shipped defaults when a field is absent from /config/full', async () => {
    // Empty config — every appearance field must resolve to DEFAULT_GLOBAL_PREFS
    // (true for booleans, overlay for streaming). This is the `?? DEFAULT` path
    // that appearanceFromFullConfig reuses from globalPrefsFromConfig.
    await openAppearanceTab({})
    expect(screen.getByRole('switch', { name: 'Show pinned “current question” header' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: 'Auto-generate session recap' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: 'Render live text inline in the transcript' }).getAttribute('aria-checked')).toBe('false')
  })

  // ── Save spreads the entire appearance object ───────────────────────

  it('saves every appearance field on Save, including explicit false', async () => {
    await openAppearanceTab(ALL_NON_DEFAULT)

    save()
    const body = await savedPayload()

    // Every appearance field is present in the payload — `...appearance` must
    // not drop a key. A false value is the literal boolean, never null/undefined
    // (PUT /config treats null/'' as "delete key", so false must be explicit).
    for (const field of APPEARANCE_FIELDS) {
      expect(body[field], `${String(field)} should be present in the Save payload`).toBeDefined()
    }
    expect(body.showPinnedUserMessage).toBe(false)
    expect(body.autoRecap).toBe(false)
    expect(body.toolGroupCards).toBe(false)
    expect(body.autoExpandRunningGroups).toBe(false)
    expect(body.showMessageHeaders).toBe(false)
    expect(body.rowGap).toBe('comfortable')
    expect(body.textSpacing).toBe('compact')
    expect(body.fontSize).toBe('large')
    expect(body.animationSpeed).toBe('fast')
    expect(body.streamingRenderMode).toBe('inline')
  })

  // ── Patch isolation: onPatch changes only its target field ──────────

  it('patching one switch changes only its target field; every other field is preserved', async () => {
    await openAppearanceTab(ALL_NON_DEFAULT)

    // Patch ONE switch — patchAppearance must merge the partial, leaving every
    // other staged field at its initialized value.
    fireEvent.click(screen.getByRole('switch', { name: 'Auto-generate session recap' }))

    save()
    const body = await savedPayload()

    // The patched field is the only one that differs from its config value.
    expect(body.autoRecap).toBe(true)
    // Every other field is preserved at its initialized value — the patch did
    // not replace the object, it merged.
    expect(body.showPinnedUserMessage).toBe(false)
    expect(body.toolGroupCards).toBe(false)
    // autoExpandRunningGroups is hidden while toolGroupCards is off, but its
    // staged value rides along and is saved.
    expect(body.autoExpandRunningGroups).toBe(false)
    expect(body.showMessageHeaders).toBe(false)
    expect(body.rowGap).toBe('comfortable')
    expect(body.textSpacing).toBe('compact')
    expect(body.fontSize).toBe('large')
    expect(body.animationSpeed).toBe('fast')
    expect(body.streamingRenderMode).toBe('inline')
  })

  it('patching one segmented preset changes only its target field', async () => {
    await openAppearanceTab(ALL_NON_DEFAULT)

    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Font size' }))
      .getByRole('radio', { name: 'X-Large' }))

    save()
    const body = await savedPayload()

    expect(body.fontSize).toBe('xlarge')
    // Every other field preserved at its initialized value.
    expect(body.showPinnedUserMessage).toBe(false)
    expect(body.autoRecap).toBe(false)
    expect(body.toolGroupCards).toBe(false)
    expect(body.autoExpandRunningGroups).toBe(false)
    expect(body.showMessageHeaders).toBe(false)
    expect(body.rowGap).toBe('comfortable')
    expect(body.textSpacing).toBe('compact')
    expect(body.animationSpeed).toBe('fast')
    expect(body.streamingRenderMode).toBe('inline')
  })

  it('successive patches accumulate without clobbering earlier ones', async () => {
    await openAppearanceTab(ALL_NON_DEFAULT)

    // Patch two independent fields — the staged object must carry both.
    fireEvent.click(screen.getByRole('switch', { name: 'Show pinned “current question” header' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Animation speed' }))
      .getByRole('radio', { name: 'Slow' }))

    save()
    const body = await savedPayload()

    expect(body.showPinnedUserMessage).toBe(true)
    expect(body.animationSpeed).toBe('slow')
    // Untouched fields are still at their initialized values.
    expect(body.autoRecap).toBe(false)
    expect(body.fontSize).toBe('large')
  })

  // ── firstPartyTools independence ────────────────────────────────────

  it('firstPartyTools stays independent of the appearance patch path', async () => {
    // firstPartyTools has its own staged state and save path — it must NOT be
    // folded into the appearance object. Toggling an appearance control must
    // not disturb it, and a non-empty map must still appear in the payload as
    // its own key.
    await openAppearanceTab({
      ...ALL_NON_DEFAULT,
      firstPartyTools: { 'git-tools': { enabled: true } },
    })

    fireEvent.click(screen.getByRole('switch', { name: 'Show pinned “current question” header' }))

    save()
    const body = await savedPayload()

    // The appearance field flipped.
    expect(body.showPinnedUserMessage).toBe(true)
    // firstPartyTools is carried by its own save path, untouched by the patch.
    expect(body.firstPartyTools).toEqual({ 'git-tools': { enabled: true } })
  })

  // ── Integration controls: deep-link + open/close ────────────────────

  it('opening the modal and navigating to the Appearance tab renders the staged controls', async () => {
    // The Appearance deep-link (group nav → Appearance leaf) must land on the
    // staged controls — the Font size segmented group is Appearance-only.
    mockGet({})
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Appearance' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Font size' })).toBeTruthy())
    // A switch control is also present — the staged state rendered.
    expect(screen.getByRole('switch', { name: 'Show pinned “current question” header' })).toBeTruthy()
  })

  it('canceling the modal after patching discards staged changes (no Save fired)', async () => {
    const onClose = vi.fn()
    await openAppearanceTab(
      { showPinnedUserMessage: false },
      { onClose },
    )

    fireEvent.click(screen.getByRole('switch', { name: 'Show pinned “current question” header' }))

    // Cancel closes without saving — the staged patch never hits PUT /config.
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalledOnce()
    expect(api.put).not.toHaveBeenCalled()
  })
})
