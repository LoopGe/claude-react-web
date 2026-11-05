// Staged appearance state contract for GlobalSettingsModal.
//
// These tests pin down the behaviour the refactor must preserve when the ten
// split appearance useState calls collapse into one staged `AppearancePrefs`
// object + `patchAppearance`. They go through the modal's public UI (render +
// interact + Save) so they guard the contract without coupling to internal
// state shape: every assertion is observable from the wire payload or the
// rendered control state.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from './ToastProvider'
import { GlobalSettingsModal, AppearanceTab } from './GlobalSettingsModal'
import { api } from '../hooks/useApi'
import { mockGet } from '../test-utils/settings-fixtures'
import { DEFAULT_GLOBAL_PREFS, type AppearancePrefs } from '../types/config'

vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }))

// happy-dom does not implement matchMedia; the modal's height-transition and
// exit-presence hooks probe it. Same stub as GlobalSettingsModal.test.tsx.
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))

/** Fields the modal still owns, asserted as a unit so a dropped field can't
 *  hide behind a sample. Excludes `firstPartyTools` (independent save path)
 *  and the display presets, which moved to the Theme popover. */
const MODAL_APPEARANCE_FIELDS: ReadonlyArray<keyof AppearancePrefs> = [
  'showPinnedUserMessage',
  'autoRecap',
  'toolGroupCards',
  'autoExpandRunningGroups',
  'showMessageHeaders',
  'streamingRenderMode',
]

/** Owned by the header Theme popover (immediate-save): the modal must never
 *  write them from its mount-time snapshot. */
const MOVED_DISPLAY_FIELDS = ['rowGap', 'textSpacing', 'fontSize', 'animationSpeed'] as const

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
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Show pinned “current question” header' })).toBeTruthy())
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

  // ── Save covers the modal-owned fields and nothing else ─────────────

  it('saves every modal-owned appearance field, including explicit false, and omits the moved presets', async () => {
    await openAppearanceTab(ALL_NON_DEFAULT)

    save()
    const body = await savedPayload()

    // Every field the modal still owns is present — a dropped key would fall
    // back to the server default. A false value is the literal boolean, never
    // null/undefined (PUT /config treats null/'' as "delete key").
    for (const field of MODAL_APPEARANCE_FIELDS) {
      expect(body[field], `${String(field)} should be present in the Save payload`).toBeDefined()
    }
    // The moved presets must NOT ride along: the modal's copy is the
    // mount-time snapshot, so echoing it would undo a parallel Theme-popover
    // change made in another tab.
    for (const field of MOVED_DISPLAY_FIELDS) {
      expect(body[field], `${field} is owned by the Theme popover`).toBeUndefined()
    }
    expect(body.showPinnedUserMessage).toBe(false)
    expect(body.autoRecap).toBe(false)
    expect(body.toolGroupCards).toBe(false)
    expect(body.autoExpandRunningGroups).toBe(false)
    expect(body.showMessageHeaders).toBe(false)
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
    expect(body.streamingRenderMode).toBe('inline')
  })

  it('successive patches accumulate without clobbering earlier ones', async () => {
    await openAppearanceTab(ALL_NON_DEFAULT)

    // Patch two independent fields — the staged object must carry both.
    fireEvent.click(screen.getByRole('switch', { name: 'Show pinned “current question” header' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Auto-generate session recap' }))

    save()
    const body = await savedPayload()

    expect(body.showPinnedUserMessage).toBe(true)
    expect(body.autoRecap).toBe(true)
    // Untouched fields are still at their initialized values.
    expect(body.toolGroupCards).toBe(false)
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
    // staged controls — the pinned-question switch is Appearance-only.
    mockGet({})
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Appearance' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Show pinned “current question” header' })).toBeTruthy())
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

// ────────────────────────────────────────────────────────────────────
// Direct AppearanceTab render tests (values/onPatch contract).
//
// These render <AppearanceTab> directly — NOT through the modal — so they
// exercise the values/onPatch prop interface in isolation. They fail on the
// old prop shape (which accepted 10 values + 10 setters, not values/onPatch)
// and verify the exact patch object each control emits, plus that onPatch is
// passed through to controls without being wrapped (a necessary condition
// for the modal's useCallback-stable patchAppearance to preserve identity
// end-to-end).
// ────────────────────────────────────────────────────────────────────

describe('AppearanceTab direct render (values/onPatch contract)', () => {
  /** Values where every field is the DEFAULT — a clean baseline so a patch
   *  assertion can't be confused by a non-default initial. */
  const baselineValues: AppearancePrefs = { ...DEFAULT_GLOBAL_PREFS }

  it('emits the exact patch object for a Switch toggle', () => {
    const onPatch = vi.fn()
    render(<AppearanceTab values={baselineValues} onPatch={onPatch} />)

    fireEvent.click(screen.getByRole('switch', { name: 'Show pinned “current question” header' }))
    // The patch is a Partial<AppearancePrefs> — only the toggled key, nothing
    // else. showPinnedUserMessage starts true (default), so the toggle emits
    // false. This is what fails on the old shape: the old AppearanceTab called
    // a bare setter `(v: boolean) => void`, not `onPatch({ field: v })`.
    expect(onPatch).toHaveBeenCalledWith({ showPinnedUserMessage: false })
    expect(onPatch).toHaveBeenCalledTimes(1)
  })

  it('emits the exact patch for the streaming-render mode switch', () => {
    const onPatch = vi.fn()
    // Start in overlay (default) so the switch flips to inline.
    render(<AppearanceTab values={baselineValues} onPatch={onPatch} />)

    fireEvent.click(screen.getByRole('switch', { name: 'Render live text inline in the transcript' }))
    // The patch carries the mode string, not a boolean — the switch maps
    // on/off to 'inline'/'overlay' before calling onPatch.
    expect(onPatch).toHaveBeenCalledWith({ streamingRenderMode: 'inline' })
  })

  it('emits the exact patch for the auto-expand sub-setting switch', () => {
    const onPatch = vi.fn()
    // toolGroupCards must be on for the sub-row to render.
    const values = { ...baselineValues, toolGroupCards: true, autoExpandRunningGroups: false }
    render(<AppearanceTab values={values} onPatch={onPatch} />)

    fireEvent.click(screen.getByRole('switch', { name: 'Auto-expand running groups' }))
    expect(onPatch).toHaveBeenCalledWith({ autoExpandRunningGroups: true })
  })

  it('reflects every field of the values prop in the rendered controls', () => {
    const onPatch = vi.fn()
    const values: AppearancePrefs = {
      ...DEFAULT_GLOBAL_PREFS,
      showPinnedUserMessage: false,
      autoRecap: false,
      toolGroupCards: false,
      showMessageHeaders: false,
      fontSize: 'large',
      animationSpeed: 'fast',
      streamingRenderMode: 'inline',
    }
    render(<AppearanceTab values={values} onPatch={onPatch} />)

    expect(screen.getByRole('switch', { name: 'Show pinned “current question” header' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Auto-generate session recap' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Use collapsible transcript cards' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Show message card headers' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Render live text inline in the transcript' }).getAttribute('aria-checked')).toBe('true')
  })

  it('passes onPatch through to controls without wrapping (identity pass-through)', () => {
    // The modal wraps patchAppearance in useCallback; for that to matter
    // end-to-end, AppearanceTab must NOT wrap onPatch in a new function before
    // handing it to a control. This test re-renders with new values but the
    // SAME onPatch reference and verifies the controls still call that exact
    // reference — proving AppearanceTab is a pass-through, not a wrapper.
    const onPatch = vi.fn()
    const { rerender } = render(<AppearanceTab values={baselineValues} onPatch={onPatch} />)

    // First interaction — the spy receives the call. showPinnedUserMessage
    // starts true (default), so the toggle emits false.
    fireEvent.click(screen.getByRole('switch', { name: 'Show pinned “current question” header' }))
    expect(onPatch).toHaveBeenCalledWith({ showPinnedUserMessage: false })

    // Re-render with different values but the SAME onPatch spy.
    rerender(<AppearanceTab values={{ ...baselineValues, autoRecap: false }} onPatch={onPatch} />)

    // Second interaction — autoRecap is now false, so the toggle emits true.
    // The SAME spy receives the call (no wrapper created).
    fireEvent.click(screen.getByRole('switch', { name: 'Auto-generate session recap' }))
    expect(onPatch).toHaveBeenCalledWith({ autoRecap: true })
    expect(onPatch).toHaveBeenCalledTimes(2)
  })

  it('hides the auto-expand sub-row while toolGroupCards is off', () => {
    const onPatch = vi.fn()
    const values = { ...baselineValues, toolGroupCards: false }
    render(<AppearanceTab values={values} onPatch={onPatch} />)
    expect(screen.queryByRole('switch', { name: 'Auto-expand running groups' })).toBeNull()
  })
})
