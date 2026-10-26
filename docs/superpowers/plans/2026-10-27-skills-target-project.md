# Skills Tab Target Project Selector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick which project a project-scope skill install targets from the global settings' Skills tab, instead of always hitting the server's `defaults.cwd`.

**Architecture:** SkillsTab derives an *effective cwd* (`user override ?? defaults.cwd` prop) and renders a target-project selector (recent-projects `<select>` + DirectoryPicker browse button + resolved `.claude/skills` hint) next to the existing Project/User scope toggle. The effective cwd feeds every install path in the tab (catalog single-install, BatchPickerModal, folder import), and every successful project-scope install remembers the cwd into the same localStorage MRU the New Session dialog reads.

**Tech Stack:** React 19, existing `useLocalStorage` hook (cross-tab synced), existing `DirectoryPicker` overlay, vitest + testing-library (jsdom).

**Spec:** Approved design in conversation 2026-10-27 (this plan is the spec — bounded task, no separate spec doc).

## Global Constraints

- CSS: never hardcode hex colors — theme variables only (`var(--…)`, defined in `src/styles/tokens.css` for both `:root` and `[data-theme="light"]`).
- Server: no changes. This is client-side only (`server/skills.ts` already accepts any absolute `cwd` and validates it).
- All new strings user-visible in English (tab copy is English); test assertions match exactly.
- Typecheck is two tsconfigs (`npm run typecheck` runs all three) — run it after implementation tasks.
- Tests: `npx vitest run src/components/GlobalSettingsModal.test.tsx`; jsdom env is file-docblock driven, `afterEach(cleanup)` already registered globally in `src/test-setup.ts` — do NOT add per-file cleanup.
- localStorage MRU must reuse the SAME key the New Session dialog uses so both surfaces share one recent-projects list: `RECENT_CWDS_KEY` = `'claude-react-web:recent-cwds'` (cap key `claude-react-web:recent-cwds-cap`, default 10, clamp 3–50).

## File Structure

- **Modify `src/components/GlobalSettingsModal.tsx`** — SkillsTab gains: destructured prop alias (`cwd: defaultCwd`), `cwdOverride` state, effective `cwd`, recent-cwds MRU state, the target selector UI, a second `DirectoryPicker` instance, and a `handleInstalled` wrapper that remembers the cwd. `RemoteInstallSection` and `BatchPickerModal` receive the effective cwd unchanged (their props already take `cwd: string`).
- **Modify `src/components/GlobalSettingsModal.test.tsx`** — new tests in the existing `GlobalSettingsModal Skills remote install` describe (its `openSkillsTab`/`remote()` helpers are reused).
- **Modify `src/styles/utilities.css`** — `.settings-skill-target` row + `.settings-skill-target-hint` styles, appended next to the existing `.settings-scope-*` rules (~line 3216).

No new files. `RemoteInstallSection` and `BatchPickerModal` signatures already accept `cwd: string` — no interface changes outside SkillsTab.

---

### Task 1: Effective cwd + target selector UI (select + hint)

**Files:**
- Modify: `src/components/GlobalSettingsModal.tsx` (SkillsTab, function starts ~line 1414; import-controls row ~line 1704)
- Modify: `src/styles/utilities.css` (append after `.settings-scope-btn.active::after`, ~line 3255)
- Test: `src/components/GlobalSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `useLocalStorage` from `../hooks/useLocalStorage`; `RECENT_CWDS_KEY, RECENT_CWDS_CAP_KEY, RECENT_CWDS_CAP_DEFAULT` from `../../constants/recentKeys`; `clamp` from `../../utils/clamp`; `isStringArray` (already imported in NewSessionDialog from `../../utils/type-guards` — verify the exact export path with `grep -n "isStringArray" src/components/session-list/NewSessionDialog.tsx` and import from the same module).
- Produces: inside SkillsTab — `const cwd: string` (effective, shadows the prop via destructure alias), `rememberCwd(raw: string): void`. Later tasks call these.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('GlobalSettingsModal Skills remote install', …)` block (reuse its `openSkillsTab(config, searchSkills)` helper):

```tsx
  it('shows a target-project selector defaulting to the server default cwd', async () => {
    const input = await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    expect(input).toBeTruthy()
    const select = screen.getByLabelText('Target project') as HTMLSelectElement
    expect(select.value).toBe('/work/proj')
    expect(select.disabled).toBe(false)
    // Resolved target hint is visible in project scope.
    expect(screen.getByText('/work/proj/.claude/skills')).toBeTruthy()
  })

  it('disables the target selector in user scope', async () => {
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    const userBtn = screen.getByRole('button', { name: 'User' })
    fireEvent.click(userBtn)
    const select = screen.getByLabelText('Target project') as HTMLSelectElement
    expect(select.disabled).toBe(true)
    // Hint disappears — user scope has no per-project target.
    expect(screen.queryByText('/work/proj/.claude/skills')).toBeNull()
  })
```

Note: `openSkillsTab` already renders with a `defaults: { cwd: … }` config fallback in some tests; the two tests above pass it explicitly. `remote()` scoping does NOT apply here — the selector is rendered inside the "Install from folder" card, so use plain `screen` queries. The existing `'User'`/`'Project'` buttons are unique on this tab (the picker modal is not mounted in these tests).

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/components/GlobalSettingsModal.test.tsx -t "target-project"`
Expected: 2 FAIL — "Unable to find an accessible element with the label text: Target project" (selector does not exist yet).

- [ ] **Step 3: Implement SkillsTab state + selector**

In `src/components/GlobalSettingsModal.tsx`:

Add imports at the top (merge into existing import lists):

```tsx
import { useLocalStorage } from '../hooks/useLocalStorage'
import { clamp } from '../utils/clamp'
import { RECENT_CWDS_KEY, RECENT_CWDS_CAP_KEY, RECENT_CWDS_CAP_DEFAULT } from '../../constants/recentKeys'
import { isStringArray } from '../../utils/type-guards'  // verify path via grep before writing
```

In `function SkillsTab({ cwd, … })` — alias the prop and add state. The destructure line becomes `cwd: defaultCwd` and the following block is added right after the existing `useState` cluster (~line 1463, next to `importScope`):

```tsx
  // Target project for project-scope installs. `defaultCwd` is the server
  // default (config `defaults.cwd`); the override is what the user picked
  // here. Null until an explicit pick, so a config reload still wins until
  // then.
  const [cwdOverride, setCwdOverride] = useState<string | null>(null)
  const cwd = cwdOverride ?? defaultCwd
  // Recent projects — the SAME MRU list the New Session dialog offers, so a
  // project used there is pickable here and vice versa.
  const [recentCwds, setRecentCwds] = useLocalStorage<string[]>(RECENT_CWDS_KEY, [], { validate: isStringArray })
  const [recentCwdsCapRaw] = useLocalStorage<number>(RECENT_CWDS_CAP_KEY, RECENT_CWDS_CAP_DEFAULT)
  const recentCwdsCap = clamp(Math.round(recentCwdsCapRaw), 3, 50)
  const rememberCwd = (raw: string) => {
    const v = raw.trim()
    if (!v) return
    setRecentCwds((prev) => [v, ...prev.filter((x) => x !== v)].slice(0, recentCwdsCap))
  }
```

Add state for the browse dialog next to `showImportPicker`:

```tsx
  const [showTargetPicker, setShowTargetPicker] = useState(false)
```

Inside the `settings-skill-import-controls` div, immediately AFTER the existing `.settings-scope-toggle` div (the Project/User buttons), insert:

```tsx
            <div className="settings-skill-target">
              <select
                className="input"
                aria-label="Target project"
                value={cwd}
                disabled={importScope === 'user'}
                onChange={(e) => setCwdOverride(e.target.value)}
              >
                {!recentCwds.includes(cwd) && <option value={cwd}>{cwd}</option>}
                {recentCwds.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            {importScope === 'project' && (
              <div className="settings-skill-target-hint">{`${cwd}/.claude/skills`}</div>
            )}
```

(The browse button is Task 2 — do not add it here.)

Append to `src/styles/utilities.css` after the `.settings-scope-*` block:

```css
/* Target-project selector for project-scope skill installs (Skills tab). */
.settings-skill-target {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.settings-skill-target .input {
  min-width: 0;
  max-width: 340px;
  font-family: var(--mono);
  font-size: var(--fs-sm);
}
.settings-skill-target-hint {
  font-family: var(--mono);
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `npx vitest run src/components/GlobalSettingsModal.test.tsx`
Expected: ALL PASS (new 2 + existing 45).

- [ ] **Step 5: Commit**

```bash
git add src/components/GlobalSettingsModal.tsx src/components/GlobalSettingsModal.test.tsx src/styles/utilities.css
git commit -m "feat(skills): target-project selector for project-scope installs"
```

---

### Task 2: Browse button → DirectoryPicker for arbitrary projects

**Files:**
- Modify: `src/components/GlobalSettingsModal.tsx` (SkillsTab JSX; `DirectoryPicker` is already imported in this file)
- Test: `src/components/GlobalSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `DirectoryPicker` props `{ title, selectLabel, footerHint, initialPath, onPick, onClose }` (all strings/callbacks, per `src/components/DirectoryPicker.tsx:36-53`); Task 1's `cwd`, `setCwdOverride`, `rememberCwd`, `showTargetPicker`.
- Produces: nothing new downstream.

- [ ] **Step 1: Write the failing test**

Append to the same describe block:

```tsx
  it('browse opens the directory picker and a pick becomes the target', async () => {
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })

    fireEvent.click(screen.getByRole('button', { name: 'Browse projects' }))
    await waitFor(() => expect(screen.getByText('Pick a project')).toBeTruthy())

    // Pick a different directory via the picker's manual-path affordance.
    // DirectoryPicker keeps a draft input; find its select button and the
    // input next to it.
    const dialog = (screen.getByText('Pick a project').closest('.modal') ??
      screen.getByText('Pick a project').parentElement!) as HTMLElement
    const draftInput = within(dialog).getByRole('textbox') as HTMLInputElement
    fireEvent.change(draftInput, { target: { value: '/other/repo' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install skills here' }))

    await waitFor(() => expect(screen.queryByText('Pick a project')).toBeNull())
    const select = screen.getByLabelText('Target project') as HTMLSelectElement
    expect(select.value).toBe('/other/repo')
    expect(screen.getByText('/other/repo/.claude/skills')).toBeTruthy()
  })
```

If the DirectoryPicker's internal structure differs (check its render: `src/components/DirectoryPicker.tsx` around line 325 — the confirm button calls `onPick(draft.trim() || path)`), adjust the queries to match reality; the assertion contract is: pick → select value + hint update, picker closed. `within` is already imported in the test file.

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/components/GlobalSettingsModal.test.tsx -t "browse opens the directory picker"`
Expected: FAIL — button named "Browse projects" not found.

- [ ] **Step 3: Implement**

In the `.settings-skill-target` div from Task 1, after the `<select>`, add:

```tsx
              <button
                type="button"
                className="btn"
                disabled={importScope === 'user'}
                onClick={() => setShowTargetPicker(true)}
              >
                Browse projects
              </button>
```

And next to the existing `showImportPicker` DirectoryPicker block (~line 1851), add:

```tsx
      {showTargetPicker && (
        <DirectoryPicker
          title="Pick a project"
          selectLabel="Install skills here"
          footerHint="Project skills install into <project>/.claude/skills"
          initialPath={cwd}
          onPick={(path) => {
            setCwdOverride(path)
            rememberCwd(path)
            setShowTargetPicker(false)
          }}
          onClose={() => setShowTargetPicker(false)}
        />
      )}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `npx vitest run src/components/GlobalSettingsModal.test.tsx`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/GlobalSettingsModal.tsx src/components/GlobalSettingsModal.test.tsx
git commit -m "feat(skills): browse arbitrary project as install target"
```

---

### Task 3: Route all installs through the effective cwd + remember it on success

**Files:**
- Modify: `src/components/GlobalSettingsModal.tsx` (SkillsTab: `handleInstalled` wrapper; RemoteInstallSection/BatchPickerModal `onInstalled` props; `finishImport`)
- Test: `src/components/GlobalSettingsModal.test.tsx`

**Interfaces:**
- Consumes: Task 1's `rememberCwd`, `cwd`, `importScope`, `refresh` (existing SkillsTab callback); Task 2's browse pick already remembers.
- Produces: behavior contract — every successful project-scope install writes the used cwd into `RECENT_CWDS_KEY`; every install POST carries the effective cwd.

- [ ] **Step 1: Write the failing test**

Append to the same describe block. This reuses `openPicker()` (which opens BatchPickerModal) — declared later in the file; if it is not in scope at the new tests' position, move this test after `openPicker`'s declaration or reuse the openSkillsTab + Browse sequence as in existing picker tests:

```tsx
  it('a project-scope install POSTs the selected target cwd and remembers it', async () => {
    mockGet2 = { defaults: { cwd: '/work/proj' } }
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })

    // Pick a different project via the select, then install from the catalog.
    const select = screen.getByLabelText('Target project') as HTMLSelectElement
    // Seed a recent entry through the localStorage the select reads.
    window.localStorage.setItem('claude-react-web:recent-cwds', JSON.stringify(['/other/repo']))
    fireEvent.change(select, { target: { value: '/other/repo' } })

    // Stub a catalog hit and install it.
    // (Use the same vi.mocked(api.get) shape as openSkillsTab: re-stub with a
    // search hit, re-render is NOT needed — search fetch happens on typing.)
    // Simplest path: type an owner/repo into Browse skills and click Open repository.
    const searchInput = screen.getByLabelText('Browse skills') as HTMLInputElement
    fireEvent.change(searchInput, { target: { value: 'org/repo' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open repository' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Open repository' }))
    await waitFor(() => expect(screen.getByText('Select skills to install')).toBeTruthy())

    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({ source: 'org/repo', skills: [{ name: 'alpha-skill', description: 'Does alpha things', relativePath: 'skills/alpha-skill' }] })
      }
      return Promise.resolve({ installed: [{ name: 'alpha-skill', relativePath: 'skills/alpha-skill' }], failed: [] })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Select skills to install' }).closest('.settings-skill-picker')!.querySelector('input[type="checkbox"]')!)
    fireEvent.click(within(document.querySelector('.settings-skill-picker') as HTMLElement).getByRole('button', { name: 'Install 1 skills' }))
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/install', expect.objectContaining({ cwd: '/other/repo', scope: 'project' })))

    // Success remembered the target into the shared recent list.
    const stored = JSON.parse(window.localStorage.getItem('claude-react-web:recent-cwds') ?? '[]')
    expect(stored).toContain('/other/repo')
  })
```

IMPORTANT adaptation notes for the implementer (the block above is a sketch — make it compile):
- Do NOT introduce `mockGet2` (leftover placeholder) — re-stub with the same `mockGet(config, …)` helper style used by sibling tests: `vi.mocked(api.get).mockImplementation(…)` returning the config for `/config/full`-shaped calls and `{ skills: [] }` for `/skills`.
- Checkbox query: use `picker()`-style scoping — `within(document.querySelector('.settings-skill-picker') as HTMLElement).getByRole('checkbox', { name: /alpha-skill/ })` after the preview lands (wait for `getByText('alpha-skill')` first). The `stubTwoSkillPreview()` helper in this file shows the exact POST mock shape.
- The assertion contract that MUST survive adaptation: POST `/skills/remote/install` called with `cwd: '/other/repo', scope: 'project'`, and `localStorage['claude-react-web:recent-cwds']` contains `'/other/repo'` after success.

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/components/GlobalSettingsModal.test.tsx -t "POSTs the selected target cwd"`
Expected: FAIL — install POST carries `cwd: '/work/proj'` (the prop) instead of `/other/repo`, and the recent list stays empty.

- [ ] **Step 3: Implement**

In SkillsTab (after `rememberCwd` and `refresh` are defined — place `handleInstalled` right after `refresh`'s `useCallback`):

```tsx
  // Every install path funnels success here: refresh the installed list AND
  // remember the project it landed in (project scope only — user scope has
  // no cwd to remember).
  const handleInstalled = useCallback(() => {
    if (importScope === 'project' && cwd) rememberCwd(cwd)
    void refresh()
  }, [importScope, cwd, rememberCwd, refresh])
```

Swap the two `onInstalled` call sites inside SkillsTab's JSX:
- `<RemoteInstallSection … onInstalled={refresh}` → `onInstalled={handleInstalled}`
- `<BatchPickerModal … onInstalled={refresh}` → `onInstalled={handleInstalled}`

In `finishImport` (~line 1553), add the remember alongside its `refresh()`:

```tsx
  const finishImport = async (result: SkillImportResponse) => {
    setNotice(`Imported ${result.skill.scope} skill "${result.skill.scope === 'project' ? cwd : '~/.claude/skills'}" …`)
```

— NO. Do not touch the notice string (YAGNI; copy churn). Only add, as the first statement of the `try`-succeeded path — i.e. immediately before `await refresh()` inside `finishImport`:

```tsx
    if (importScope === 'project' && cwd) rememberCwd(cwd)
```

- [ ] **Step 4: Run to verify GREEN + full gates**

Run: `npx vitest run src/components/GlobalSettingsModal.test.tsx` → ALL PASS.
Run: `npm run typecheck` → exit 0.
Run: `npx eslint src/components/GlobalSettingsModal.tsx src/components/GlobalSettingsModal.test.tsx` → no new warnings.

- [ ] **Step 5: Commit**

```bash
git add src/components/GlobalSettingsModal.tsx src/components/GlobalSettingsModal.test.tsx
git commit -m "feat(skills): installs use the selected target project and remember it"
```

---

## Self-Review (done at write time)

1. **Spec coverage:** selector defaults to server default cwd (Task 1) ✓; disabled in user scope + hint hidden (Task 1) ✓; resolved `.claude/skills` hint (Task 1) ✓; browse arbitrary directory (Task 2) ✓; governs all three install paths (Task 3: RemoteInstallSection via prop cwd, BatchPickerModal via prop cwd, folder import via same `cwd` variable in `importFromServerPath`) ✓; remembers into shared MRU (Task 3 + Task 2 pick) ✓.
2. **Placeholder scan:** Task 3 Step 1 contains a flagged sketch with explicit adaptation instructions and an inviolable assertion contract — acceptable per the skill only because the exact queries depend on runtime DOM; implementer must make it compile and keep the contract. All other steps carry real code.
3. **Type consistency:** `rememberCwd(raw: string): void` used in Task 2 and Task 3 matches Task 1's definition; `showTargetPicker`/`setShowTargetPicker`/`cwdOverride`/`setCwdOverride` names consistent; `cwd` in SkillsTab is the effective value everywhere below Task 1 (prop aliased to `defaultCwd`) — the plan's edits to `finishImport`/`importFromServerPath` reference that `cwd` binding, which resolves correctly because both live inside SkillsTab.
