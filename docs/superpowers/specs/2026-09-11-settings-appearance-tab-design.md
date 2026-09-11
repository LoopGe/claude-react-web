# Settings: extract an `Appearance` tab

Date: 2026-09-11
Status: proposed (awaiting review)

## Problem

Two settings surfaces have grown display-related options mixed into
catch-all tabs:

- **Global Settings → Server tab** holds three unrelated groups:
  *Limits* (server infrastructure: max upload, history cap,
  working-stuck timeout, max group panels), *Preferences* (per-session
  display/behaviour defaults), and *Permissions* (one switch).
- **Session Settings → General tab** holds five groups: *Session*
  (read-only metadata), *Live controls*, *Memory*, *Sandbox*, and
  *Preferences* (per-session overrides of the display defaults).

Both tabs are long and mix concerns. Peel the *Preferences* group out
of each into a dedicated **`Appearance`** tab.

## Decisions (confirmed with the user)

| Question | Decision |
| --- | --- |
| Tab contents | The **entire** existing *Preferences* group — including `autoRecap`, which is behaviour rather than pure display. Move the group intact; no re-curation. |
| Tab name | `Appearance` |
| Scope | Both surfaces — global modal **and** session panel. |

## Non-goals

- No change to any persisted config key, API route, or server logic.
- No change to the per-session override / inheritance semantics.
- No re-layout of the remaining groups (Limits/Permissions stay as-is;
  Session/Live controls/Memory/Sandbox stay as-is).
- No new CSS. The tab bar already wraps on desktop and horizontally
  scrolls on mobile (`.global-settings-tabs` in `src/styles/messages.css`
  + the narrow-viewport override in `src/styles/utilities.css`).

## What moves

### Global Settings modal — 7 rows

| Row | Control | State field |
| --- | --- | --- |
| Show pinned "current question" header | Switch | `showPinnedUserMessage` |
| Auto-generate session recap | Switch | `autoRecap` |
| Use collapsible tool-group cards | Switch | `toolGroupCards` |
| Show message card headers | Switch | `showMessageHeaders` |
| Transcript spacing | Segmented (`ROW_GAP_PRESETS`) | `rowGap` |
| Message text density | Segmented (`TEXT_SPACING_PRESETS`) | `textSpacing` |
| Font size | Segmented (`FONT_SIZE_PRESETS`) | `fontSize` |

### Session Settings panel — 4 rows

`showPinnedUserMessage`, `autoRecap`, `toolGroupCards`,
`showMessageHeaders` — same rows, but each renders an effective value
(`session.<field> ?? globalPrefs.<field>`) plus a *Reset (inherit
global)* link when a session override is set. No spacing / density /
font-size rows exist here — those are global-only.

## Implementation

### 1. `src/components/GlobalSettingsModal.tsx`

**1.1 Type union** (currently line 65) — insert `'appearance'` after
`'server'`:

```ts
type Tab = 'profiles' | 'server' | 'appearance' | 'skills' | 'mcp'
  | 'marketplace' | 'app-plugins' | 'share' | 'logs' | 'about'
```

**1.2 Tab list** (currently lines 334–344) — insert after the `server`
entry:

```ts
{ key: 'appearance', label: 'Appearance' },
```

**1.3 Render branch** — add after the existing `{tab === 'server' && …}`
block:

```tsx
{tab === 'appearance' && (
  <AppearanceTab
    showPinnedUserMessage={showPinnedUserMessage}
    autoRecap={autoRecap}
    toolGroupCards={toolGroupCards}
    showMessageHeaders={showMessageHeaders}
    rowGap={rowGap}
    textSpacing={textSpacing}
    fontSize={fontSize}
    onShowPinnedUserMessageChange={setShowPinnedUserMessage}
    onAutoRecapChange={setAutoRecap}
    onToolGroupCardsChange={setToolGroupCards}
    onShowMessageHeadersChange={setShowMessageHeaders}
    onRowGapChange={setRowGap}
    onTextSpacingChange={setTextSpacing}
    onFontSizeChange={setFontSize}
  />
)}
```

**1.4 Trim `ServerTab`** — remove the seven `*Change` props and the
seven value props from both the destructure and the inline prop type.
The `ServerTab` invocation shrinks to the five remaining fields:

```tsx
<ServerTab
  maxUploadBytes={maxUploadBytes}
  historyCap={historyCap}
  maxGroupPanels={maxGroupPanels}
  workingStuckMs={workingStuckMs}
  allowSensitivePathEdits={allowSensitivePathEdits}
  onMaxUploadBytesChange={setMaxUploadBytes}
  onHistoryCapChange={setHistoryCap}
  onMaxGroupPanelsChange={setMaxGroupPanels}
  onWorkingStuckMsChange={setWorkingStuckMs}
  onAllowSensitivePathEditsChange={setAllowSensitivePathEdits}
/>
```

Then delete the whole **Preferences `<section>`** from `ServerTab`'s
JSX (currently lines 674–758). `ServerTab` keeps *Limits* (4 rows,
incl. `Stepper`) and *Permissions* (1 row, `Switch`).

**1.5 New `AppearanceTab` component** — define it in the same file,
immediately after `ServerTab`, matching the file's existing convention
(`ServerTab`/`SkillsTab`/`McpTab`/`LogsTab`/`AboutTab` all live here).
Structure:

```tsx
function AppearanceTab({ …13 props… }: { … }) {
  return (
    <div className="settings-stack">
      <section className="settings-group">
        <div className="settings-group-head">
          <h4>Display defaults</h4>
          <span className="settings-group-desc">
            Defaults for every session. Individual sessions can override
            these in their own Settings panel.
          </span>
        </div>
        {/* the 7 SettingsRows, moved verbatim from ServerTab's
            Preferences section (currently lines 682–757) */}
      </section>
    </div>
  )
}
```

The rows, hints, `Segmented` usage, and `labelFor` mappings are moved
byte-for-byte — the only textual change is the group heading
(`Preferences` → `Display defaults`) and the leading comment.

**1.6 Unchanged:** the modal still owns all seven `useState` hooks, and
`handleSave` still writes all seven keys — the tab is purely a
presentation split. `heightAnimationKey` already includes `tab`, so the
auto-height transition keeps working with no change.

**1.7 Imports:** `Segmented` and the `ROW_GAP_*` / `TEXT_SPACING_*` /
`FONT_SIZE_*` / `DEFAULT_*` imports stay in the file (now consumed by
`AppearanceTab`). `Stepper` stays (still used by `ServerTab`).

### 2. `src/components/SettingsPanel.tsx`

**2.1 Type union** (currently line 52) — insert `'appearance'` after
`'general'`.

**2.2 Tab list** (currently lines 849–860) — insert after the `general`
entry:

```ts
{ key: 'appearance', label: 'Appearance' },
```

**2.3 Render branch** — add a `{tab === 'appearance' && ( … )}` block
after the `tab === 'general'` block (which currently ends at line
1388). It contains the *Preferences* `<section>` moved verbatim from
General (currently lines 1272–1386), wrapped in the same
`<div className="settings-stack">` the General tab uses, with the group
heading retitled `Preferences` → `Display`. Description text is
unchanged:

> Per-session overrides of the global defaults. Reset restores
> inheritance.

**2.4 Unchanged:** `changePref`, the four `eff*` derivations, the
`globalPrefs` prop, and every handler. The General tab keeps *Session*
(read-only) / *Live controls* / *Memory* / *Sandbox*.

### 3. `src/local-commands.ts` — type unchanged, comment corrected

`SettingsTabName` (line 20) is a deliberate **subset** of
`SettingsPanel`'s `SettingsTab` — only the tabs reachable by a slash
command (`general`/`context`/`hooks`/`plugins`/`mcp`). The wider union
is assignable to it at the `tabRequest` boundary, and no command targets
`appearance`. Adding a deep-link for it would be scope creep, so the
type is left alone.

Its doc comment, however, claimed "Keep in sync with SettingsTab" — an
invariant that was never true (the union has always been a subset) and
that this change makes visibly false. Reworded to state the subset
relationship explicitly.

### 4. Tests

**4.1 `src/components/GlobalSettingsModal.test.tsx`**

- In *"renders human units, the segmented panel picker, and switch
  states from config"* (lines 145–170): **drop** the two assertions on
  the relocated switches (lines 167–168 — the pinned-header and
  auto-recap ones). Keep the Limits assertions and the
  `allowSensitivePathEdits` assertion (line 169), which stays on the
  Server tab.
- Add a new suite:

```tsx
describe('GlobalSettingsModal Appearance tab', () => {
  beforeEach(() => { vi.mocked(api.put).mockResolvedValue({}) })

  const openAppearanceTab = async (config: Record<string, unknown>) => {
    mockGet(config)
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Appearance' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    // Content is gated on the /config/full fetch — wait for an
    // Appearance-only control.
    await waitFor(() =>
      expect(screen.getByRole('radiogroup', { name: 'Font size' })).toBeTruthy())
  }

  it('renders the display defaults from config', async () => {
    await openAppearanceTab({
      showPinnedUserMessage: true,
      autoRecap: false,
      toolGroupCards: true,
      showMessageHeaders: false,
      rowGap: 'comfortable',
      textSpacing: 'compact',
      fontSize: 'large',
    })
    expect(screen.getByRole('switch',
      { name: 'Show pinned “current question” header' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch',
      { name: 'Auto-generate session recap' }).getAttribute('aria-checked')).toBe('false')
    // Each segmented group reflects its configured preset. Scope by the
    // radiogroup — the space/density groups reuse the same labels.
    within(screen.getByRole('radiogroup', { name: 'Transcript spacing' }))
      .getByRole('radio', { name: 'Comfortable' }).getAttribute('aria-checked')
    expect(within(screen.getByRole('radiogroup', { name: 'Message text density' }))
      .getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe('true')
    expect(within(screen.getByRole('radiogroup', { name: 'Font size' }))
      .getByRole('radio', { name: 'Large' }).getAttribute('aria-checked')).toBe('true')
  })

  it('persists a switch flip and a preset change on Save', async () => {
    await openAppearanceTab({ showPinnedUserMessage: true, fontSize: 'standard' })
    fireEvent.click(screen.getByRole('switch',
      { name: 'Show pinned “current question” header' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Font size' }))
      .getByRole('radio', { name: 'X-Large' }))
    save()
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith('/config',
      expect.objectContaining({ showPinnedUserMessage: false, fontSize: 'xlarge' }))
  })
})
```

Add `within` to the `@testing-library/react` import for this file.

**Preset vocabulary** (for fixtures — verified in `shared/`):

| Setting | Presets | Shipped default |
| --- | --- | --- |
| `rowGap` | `compact` \| `comfortable` \| `spacious` \| `airy` | `spacious` |
| `textSpacing` | `compact` \| `comfortable` \| `spacious` \| `airy` | `spacious` |
| `fontSize` | `small` \| `standard` \| `large` \| `xlarge` | `standard` |

> Note `fontSize` has **no `medium`** — a `medium` fixture would fall
> through to the default. Segmented labels are title-cased
> (`Comfortable`, `X-Large`), and the two spacing groups share all four
> labels, so every segmented assertion must be scoped with `within(...)`
> on its radiogroup.

- The existing *"persists a segmented panel choice and a switch flip"*
  test (lines 226–243) is unaffected: it only clicks `Max group panels`
  and the sensitive-paths switch, both of which stay on the Server tab.

**4.2 `src/components/SettingsPanel.test.tsx`**

- Extend `renderPanel` (lines 42–64) with an optional `tab` argument
  (default `'mcp'`, preserving every existing call site) so a test can
  request `'appearance'`.
- Add a test asserting the Appearance tab renders the four override
  rows and that toggling one POSTs the per-session override:

```tsx
it('renders per-session display overrides and posts an override', async () => {
  vi.mocked(api.post).mockResolvedValue({ session: mkSession() })
  renderPanel({ tab: 'appearance' })
  await waitFor(() => expect(screen.getByRole('switch',
    { name: 'Show pinned current question header' })).toBeTruthy())
  fireEvent.click(screen.getByRole('switch',
    { name: 'Show pinned current question header' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith(
    '/sessions/s1/prefs', { showPinnedUserMessage: false }))
})
```

> Note the session-side label has **no** curly quotes
> (`Show pinned current question header`), unlike the global modal's
> `Show pinned “current question” header`. Keep the two distinct.

**4.3 `src/hooks/useSessionRecap.ts`** — two stale comments (lines 71
and 101) refer to the toggle living in "Preferences". Update the wording
to "the Appearance tab". Comments only; no behaviour change.

## Verification

1. `npm run typecheck` — both tsconfigs.
2. `npm run test` — `GlobalSettingsModal.test.tsx`,
   `SettingsPanel.test.tsx`, `local-commands.test.ts`.
3. `npm run lint`.
4. Manual smoke (dev server):
   - Global Settings → **Appearance**: all 7 rows render; flipping a
     switch + changing a preset + **Save** persists (reopen to confirm).
   - Session Settings → **Appearance**: 4 rows render; toggling writes
     an override and shows *Reset (inherit global)*; Reset restores the
     "Inheriting global (ON/OFF)" hint.
   - Confirm **Server** now shows only *Limits* + *Permissions*, and
     **General** shows only *Session* / *Live controls* / *Memory* /
     *Sandbox*.
   - Confirm the tab bar wraps (desktop) / scrolls (narrow viewport)
     without clipping the new tab.
5. `code-review` skill over `git diff HEAD` before committing (per
   `CLAUDE.md`).

## Risk

Low. Pure presentation extraction: no state, persistence, API, or
override-logic change. The only behavioural risk is a mis-moved
`SettingsRow` (wrong handler wiring), which the typechecker catches for
prop-name mistakes and the two new tests catch for wiring mistakes.

## Addendum (post-review): the theme panel was renamed to "Theme"

Code review flagged that the new `Appearance` tab collided with the
pre-existing `AppearancePanel` — the toolbar popover for skin / colour
mode / accent / background, whose trigger button and dialog were both
`aria-label="Appearance"` and which is mounted for the whole app's
lifetime (`App.tsx`). With settings open, the document held two
different controls answering to the accessible name "Appearance".
Resolved by renaming the **existing theme panel** to `Theme` (the user's
call), not the new tab:

- `src/components/AppearancePanel.tsx` — `aria-label="Appearance"` →
  `"Theme"` on both the trigger and the dialog; the trigger's `title`
  becomes `"Theme — skin, mode & accent"` (the old tail "theme, mode &
  accent" would have read "Theme — theme, …", and "skin" is the word the
  panel's own first section heading already uses).
- `src/components/AppearancePanel.test.tsx` — the two `openPanel()`
  queries now look up `Theme`.

Deliberately **not** renamed: the component/file identifier
`AppearancePanel` and the `.appearance-*` CSS classes. Those classes are
consumed by `BackgroundPicker.tsx` and a dozen stylesheets; renaming
them is a large unrelated refactor, and a `ThemePanel` still rendering
`.appearance-*` classes would be *more* misleading than the current
split. The collision was about the user-facing name, which is what
changed.
</content>
</invoke>
