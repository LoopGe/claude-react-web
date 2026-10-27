import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastProvider } from './ToastProvider'
import { GlobalSettingsModal } from './GlobalSettingsModal'
import { api } from '../hooks/useApi'
import { gitToolsInfo, mockGet } from '../test-utils/settings-fixtures'
import type { RemoteSearchHit } from '../../shared/skills'

vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }))

// jsdom doesn't implement matchMedia; the modal's height-transition and
// exit-presence hooks probe it. Same stub as SettingsPanel/NewSessionDialog.
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))

/** One skills.sh catalog hit. `skillId` is the clone-relative directory
 *  basename that `matchSearchHit` keys on. */
const catalogHit = (over: Partial<RemoteSearchHit> = {}): RemoteSearchHit => ({
  id: 'hit-1',
  source: 'org/repo',
  skillId: 'react-helper',
  name: 'react-helper',
  installs: 1234,
  ...over,
})

/** Two previewed skills for the repository checklist — distinct name,
 *  description and relativePath so selection (keyed by relativePath) is
 *  observable. */
const stubTwoSkillPreview = (install?: (path: string) => unknown) => {
  vi.mocked(api.post).mockImplementation((path: string) => {
    if (path === '/skills/remote/preview') {
      return Promise.resolve({
        source: 'org/repo',
        skills: [
          { name: 'alpha-skill', description: 'Does alpha things', relativePath: 'skills/alpha-skill' },
          { name: 'beta-skill', description: 'Does beta things', relativePath: 'skills/beta-skill' },
        ],
      })
    }
    return Promise.resolve(install ? install(path) : { installed: [], failed: [] })
  })
}

describe('GlobalSettingsModal Skills unified add card', () => {
  beforeEach(() => {
    vi.mocked(api.put).mockResolvedValue({})
    vi.mocked(api.put).mockClear()
    vi.mocked(api.post).mockReset()
    vi.mocked(api.get).mockClear()
  })

  /** Land on the Skills tab (the Extensions group's first leaf) with the
   *  unified add card on screen, and return the catalog search input. */
  const openSkillsTab = async (
    config: Record<string, unknown>,
    searchSkills: RemoteSearchHit[] = [],
  ) => {
    mockGet(config, [gitToolsInfo], searchSkills)
    const view = render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByText('Extensions')).toBeTruthy())
    fireEvent.click(screen.getByText('Extensions'))
    await waitFor(() => expect(screen.getByLabelText('Search skills')).toBeTruthy())
    return { input: screen.getByLabelText('Search skills') as HTMLInputElement, view }
  }

  /** The unified add card — everything (chips, body, shared footer) lives
   *  inside it, so scoped queries keep the Installed Skills list and the
   *  loading-mode cards out of the matches. */
  const addCard = () => {
    const el = document.querySelector('.settings-skill-add-group')
    expect(el, 'unified add card').toBeTruthy()
    return within(el as HTMLElement)
  }

  /** GETs of the catalog search (`/skills/search?…`), as opposed to the
   *  installed-list fetch (`/skills` or `/skills?cwd=…`). */
  const searchGets = () =>
    vi.mocked(api.get).mock.calls.filter(([u]) => String(u).startsWith('/skills/search'))
  const listGets = () =>
    vi.mocked(api.get).mock.calls.filter(([u]) => {
      const s = String(u)
      return s === '/skills' || s.startsWith('/skills?')
    })

  it('heads the section "Add skill" and offers three source chips', async () => {
    await openSkillsTab({})
    expect(screen.getByRole('heading', { name: 'Add skill' })).toBeTruthy()
    expect(addCard().getByRole('button', { name: 'Search catalog' })).toBeTruthy()
    expect(addCard().getByRole('button', { name: 'Repository' })).toBeTruthy()
    expect(addCard().getByRole('button', { name: 'Folder' })).toBeTruthy()
    // The two old section cards are gone as separate sections.
    expect(screen.queryByRole('heading', { name: 'Browse skills' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Install from folder' })).toBeNull()
  })

  it('source chips switch the body', async () => {
    await openSkillsTab({})
    // Default: catalog search.
    expect(addCard().getByLabelText('Search skills')).toBeTruthy()
    expect(addCard().queryByLabelText('Repository source')).toBeNull()

    fireEvent.click(addCard().getByRole('button', { name: 'Repository' }))
    expect(addCard().getByLabelText('Repository source')).toBeTruthy()
    expect(addCard().queryByLabelText('Search skills')).toBeNull()

    fireEvent.click(addCard().getByRole('button', { name: 'Folder' }))
    expect(addCard().getByRole('button', { name: 'Choose local folder' })).toBeTruthy()
    expect(addCard().getByLabelText('Server path to skill folder')).toBeTruthy()
    expect(addCard().queryByLabelText('Search skills')).toBeNull()
    expect(addCard().queryByLabelText('Repository source')).toBeNull()
  })

  it('renders search results with Install and Open repo', async () => {
    const { input } = await openSkillsTab({}, [catalogHit()])
    fireEvent.change(input, { target: { value: 'react' } })
    // 300 ms debounce: the wire is still quiet at this instant.
    expect(searchGets()).toHaveLength(0)
    await waitFor(() => expect(addCard().getByText('react-helper')).toBeTruthy())
    expect(searchGets()).toHaveLength(1)
    expect(searchGets()[0]![0]).toBe('/skills/search?q=react')
    expect(addCard().getByText('org/repo')).toBeTruthy()
    expect(addCard().getByText((1234).toLocaleString())).toBeTruthy()
    expect(addCard().getByRole('button', { name: 'Install' })).toBeTruthy()
    expect(addCard().getByRole('button', { name: 'Open repo' })).toBeTruthy()
  })

  it('flips a row to Installed after a successful install', async () => {
    // Preview returns DiscoveredSkill[] — the component must match the hit
    // against THESE, not the SkillRecord[] prop (whose relativePath is
    // cwd-relative to SKILL.md, not a clone-relative directory).
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'react-helper', description: 'Does react things', relativePath: 'skills/react-helper' }],
        })
      }
      return Promise.resolve({
        installed: [{ name: 'react-helper', relativePath: 'skills/react-helper' }],
        failed: [],
      })
    })
    const { input } = await openSkillsTab({ defaults: { cwd: '/work/proj' } }, [catalogHit()])
    fireEvent.change(input, { target: { value: 'react' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Install' })).toBeTruthy())
    const listsBefore = listGets().length

    fireEvent.click(addCard().getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(addCard().getByText('✓ Installed')).toBeTruthy())
    expect(addCard().queryByRole('button', { name: 'Install' })).toBeNull()

    // onInstalled → SkillsTab.refresh(), observable as a second list fetch.
    await waitFor(() => expect(listGets().length).toBeGreaterThan(listsBefore))
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/install', {
      source: 'org/repo',
      scope: 'project',
      cwd: '/work/proj',
      paths: ['skills/react-helper'],
      overwrite: false,
    }, { timeoutMs: 60_000 })
  })

  it('shows the Installed badge only in the scope it was installed to', async () => {
    // Install into Project (the default scope), then flip the Project/User
    // toggle: the badge must not claim the skill is installed in User scope.
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'react-helper', description: 'Does react things', relativePath: 'skills/react-helper' }],
        })
      }
      return Promise.resolve({
        installed: [{ name: 'react-helper', relativePath: 'skills/react-helper' }],
        failed: [],
      })
    })
    const { input } = await openSkillsTab({ defaults: { cwd: '/work/proj' } }, [catalogHit()])
    fireEvent.change(input, { target: { value: 'react' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Install' })).toBeTruthy())
    fireEvent.click(addCard().getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(addCard().getByText('✓ Installed')).toBeTruthy())

    fireEvent.click(addCard().getByRole('button', { name: 'User' }))
    await waitFor(() => expect(addCard().queryByText('✓ Installed')).toBeNull())
    expect(addCard().getByRole('button', { name: 'Install' })).toBeTruthy()
  })

  it('shows an inline error when the skill is not found in the repo', async () => {
    // The preview discovers the clone's skills — none of them is this hit.
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'other-skill', description: 'Not the hit', relativePath: 'skills/other-skill' }],
        })
      }
      return Promise.resolve({ installed: [], failed: [] })
    })
    const { input } = await openSkillsTab({}, [catalogHit()])
    fireEvent.change(input, { target: { value: 'react' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Install' })).toBeTruthy())

    fireEvent.click(addCard().getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(addCard().getByText('Not found in org/repo')).toBeTruthy())
    // Open repo stays the way into the repo — never disabled by a failed match.
    expect((addCard().getByRole('button', { name: 'Open repo' }) as HTMLButtonElement).disabled).toBe(false)
    // Only the preview went out; a miss never reaches /install.
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/preview', { source: 'org/repo' }, { timeoutMs: 60_000 })
    expect(vi.mocked(api.post)).not.toHaveBeenCalledWith('/skills/remote/install', expect.anything(), expect.anything())
  })

  it('Open repo on a result row switches to the Repository tab prefilled', async () => {
    stubTwoSkillPreview()
    const { input } = await openSkillsTab({}, [catalogHit()])
    fireEvent.change(input, { target: { value: 'react' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Open repo' })).toBeTruthy())

    fireEvent.click(addCard().getByRole('button', { name: 'Open repo' }))
    // Repository tab is active, the source is prefilled, and the checklist
    // loads inline — no modal.
    expect((addCard().getByLabelText('Repository source') as HTMLInputElement).value).toBe('org/repo')
    expect(document.querySelector('.settings-skill-picker')).toBeNull()
    await waitFor(() => expect(addCard().getByText('Does alpha things')).toBeTruthy())
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/preview', { source: 'org/repo' }, { timeoutMs: 60_000 })
  })

  it('Open repository on an owner/repo query switches to the Repository tab', async () => {
    stubTwoSkillPreview()
    const { input } = await openSkillsTab({})
    fireEvent.change(input, { target: { value: 'vercel-labs/agent-skills' } })
    // Parsed from the raw query — not gated on the debounced search.
    const openRepo = addCard().getByRole('button', { name: 'Open repository' }) as HTMLButtonElement
    expect(openRepo.disabled).toBe(false)

    fireEvent.click(openRepo)
    expect((addCard().getByLabelText('Repository source') as HTMLInputElement).value).toBe('vercel-labs/agent-skills')
    await waitFor(() => expect(addCard().getByRole('checkbox', { name: /Select All/ })).toBeTruthy())
  })

  it('lists the repository skills inline with descriptions and Select All', async () => {
    stubTwoSkillPreview()
    const { input } = await openSkillsTab({})
    fireEvent.change(input, { target: { value: 'org/repo' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Open repository' })).toBeTruthy())
    fireEvent.click(addCard().getByRole('button', { name: 'Open repository' }))

    await waitFor(() => expect(addCard().getByText('org/repo · 2 skills found')).toBeTruthy())
    expect(addCard().getByRole('checkbox', { name: /Select All/ })).toBeTruthy()
    expect(addCard().getByText('Does alpha things')).toBeTruthy()
    expect(addCard().getByText('Does beta things')).toBeTruthy()
    // The list renders inline in the card, not in the retired modal.
    expect(document.querySelector('.settings-skill-picker')).toBeNull()
  })

  it('installs only the checked skills and shows per-row status and summary', async () => {
    stubTwoSkillPreview(() => ({
      installed: [{ name: 'alpha-skill', relativePath: 'skills/alpha-skill' }],
      failed: [{ name: 'beta-skill', relativePath: 'skills/beta-skill', error: 'Missing SKILL.md' }],
    }))
    const { input } = await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    fireEvent.change(input, { target: { value: 'org/repo' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Open repository' })).toBeTruthy())
    fireEvent.click(addCard().getByRole('button', { name: 'Open repository' }))
    await waitFor(() => expect(addCard().getByRole('checkbox', { name: /alpha-skill/ })).toBeTruthy())

    // Footer button tracks the selection size and is disabled at zero.
    const zeroBtn = addCard().getByRole('button', { name: 'Install selected (0)' }) as HTMLButtonElement
    expect(zeroBtn.disabled).toBe(true)
    fireEvent.click(addCard().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(addCard().getByRole('button', { name: 'Install selected (1)' }))

    // Per-row status (full text on hover) + install summary.
    await waitFor(() => expect(addCard().getByText('✓')).toBeTruthy())
    expect(addCard().getByText('Missing SKILL.md').getAttribute('title')).toBe('Missing SKILL.md')
    expect(addCard().getByText('1 installed · 1 failed')).toBeTruthy()
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/install', {
      source: 'org/repo',
      scope: 'project',
      cwd: '/work/proj',
      paths: ['skills/alpha-skill'],
      overwrite: false,
    }, { timeoutMs: 60_000 })
    // The list stays live after the install, but the SUCCEEDED row drops out
    // of the selection — re-POSTing it would 409 'Skill already exists' on
    // the server and paint a red error over a correctly installed skill.
    expect((addCard().getByRole('checkbox', { name: /alpha-skill/ }) as HTMLInputElement).disabled).toBe(false)
    expect((addCard().getByRole('checkbox', { name: /alpha-skill/ }) as HTMLInputElement).checked).toBe(false)
  })

  it('keeps failed rows selected for retry after a batch install', async () => {
    stubTwoSkillPreview(() => ({
      installed: [{ name: 'alpha-skill', relativePath: 'skills/alpha-skill' }],
      failed: [{ name: 'beta-skill', relativePath: 'skills/beta-skill', error: 'Missing SKILL.md' }],
    }))
    const { input } = await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    fireEvent.change(input, { target: { value: 'org/repo' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Open repository' })).toBeTruthy())
    fireEvent.click(addCard().getByRole('button', { name: 'Open repository' }))
    await waitFor(() => expect(addCard().getByRole('checkbox', { name: /alpha-skill/ })).toBeTruthy())

    fireEvent.click(addCard().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(addCard().getByRole('checkbox', { name: /beta-skill/ }))
    fireEvent.click(addCard().getByRole('button', { name: 'Install selected (2)' }))
    await waitFor(() => expect(addCard().getByText('1 installed · 1 failed')).toBeTruthy())

    // Succeeded cleared, failed kept so one click retries the failure.
    expect((addCard().getByRole('checkbox', { name: /alpha-skill/ }) as HTMLInputElement).checked).toBe(false)
    expect((addCard().getByRole('checkbox', { name: /beta-skill/ }) as HTMLInputElement).checked).toBe(true)
    expect(addCard().getByRole('button', { name: 'Install selected (1)' })).toBeTruthy()
  })

  it('filters the inline list and Select All toggles only visible rows', async () => {
    stubTwoSkillPreview()
    const { input } = await openSkillsTab({})
    fireEvent.change(input, { target: { value: 'org/repo' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Open repository' })).toBeTruthy())
    fireEvent.click(addCard().getByRole('button', { name: 'Open repository' }))
    await waitFor(() => expect(addCard().getByRole('checkbox', { name: /Select All/ })).toBeTruthy())

    fireEvent.change(addCard().getByRole('textbox', { name: 'Filter skills' }), { target: { value: 'alpha' } })
    expect(addCard().queryByText('beta-skill')).toBeNull()
    // Subtitle still reports the full found count, not the filtered one.
    expect(addCard().getByText('org/repo · 2 skills found')).toBeTruthy()

    fireEvent.click(addCard().getByRole('checkbox', { name: /Select All/ }))
    // The filtered-out row must stay unselected.
    fireEvent.change(addCard().getByRole('textbox', { name: 'Filter skills' }), { target: { value: '' } })
    expect((addCard().getByRole('checkbox', { name: /alpha-skill/ }) as HTMLInputElement).checked).toBe(true)
    expect((addCard().getByRole('checkbox', { name: /beta-skill/ }) as HTMLInputElement).checked).toBe(false)
  })

  it('footer scope toggle switches the install target between project and user', async () => {
    // The first install succeeds for alpha-skill, so its row drops out of the
    // selection before the second round.
    stubTwoSkillPreview(() => ({
      installed: [{ name: 'alpha-skill', relativePath: 'skills/alpha-skill' }],
      failed: [],
    }))
    const { input } = await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    fireEvent.change(input, { target: { value: 'org/repo' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Open repository' })).toBeTruthy())
    fireEvent.click(addCard().getByRole('button', { name: 'Open repository' }))
    await waitFor(() => expect(addCard().getByRole('checkbox', { name: /alpha-skill/ })).toBeTruthy())

    fireEvent.click(addCard().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(addCard().getByRole('button', { name: 'Install selected (1)' }))
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/install', expect.objectContaining({ scope: 'project' }), { timeoutMs: 60_000 }))

    // Flip the shared footer toggle to User before installing again. The
    // first install succeeded, so its row dropped out of the selection.
    vi.mocked(api.post).mockClear()
    fireEvent.click(addCard().getByRole('button', { name: 'User' }))
    fireEvent.click(addCard().getByRole('checkbox', { name: /beta-skill/ }))
    fireEvent.click(addCard().getByRole('button', { name: 'Install selected (1)' }))
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/install', expect.objectContaining({
      scope: 'user',
      cwd: undefined,
    }), { timeoutMs: 60_000 }))
  })

  it('a failed row install still refreshes the installed list', async () => {
    // The POST may have landed files before the failure (or a stale list is
    // what caused the 409) — the GET is the source of truth either way.
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'react-helper', description: 'Does react things', relativePath: 'skills/react-helper' }],
        })
      }
      return Promise.reject(new Error('boom'))
    })
    const { input } = await openSkillsTab({ defaults: { cwd: '/work/proj' } }, [catalogHit()])
    fireEvent.change(input, { target: { value: 'react' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Install' })).toBeTruthy())
    const listsBefore = listGets().length

    fireEvent.click(addCard().getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(addCard().getByText('boom')).toBeTruthy())
    await waitFor(() => expect(listGets().length).toBeGreaterThan(listsBefore))
  })

  it('a failed folder install still refreshes the installed list', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('boom'))
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    fireEvent.click(addCard().getByRole('button', { name: 'Folder' }))
    fireEvent.change(addCard().getByLabelText('Server path to skill folder'), { target: { value: '/srv/skills/helper' } })
    const listsBefore = listGets().length

    fireEvent.click(addCard().getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(addCard().getByText('boom')).toBeTruthy())
    await waitFor(() => expect(listGets().length).toBeGreaterThan(listsBefore))
  })

  it('Open repository retries the preview when the previous one failed', async () => {
    // A network blip must not strand the tab on the error: clicking Open
    // repository again refetches (the old modal remounted per open and did).
    let failFirst = true
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        if (failFirst) {
          failFirst = false
          return Promise.reject(new Error('blip'))
        }
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'alpha-skill', description: 'Does alpha things', relativePath: 'skills/alpha-skill' }],
        })
      }
      return Promise.resolve({ installed: [], failed: [] })
    })
    const { input } = await openSkillsTab({})
    fireEvent.change(input, { target: { value: 'org/repo' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Open repository' })).toBeTruthy())
    fireEvent.click(addCard().getByRole('button', { name: 'Open repository' }))
    await waitFor(() => expect(addCard().getByText('blip')).toBeTruthy())

    fireEvent.click(addCard().getByRole('button', { name: 'Open repository' }))
    await waitFor(() => expect(addCard().getByText('Does alpha things')).toBeTruthy())
    const previews = vi.mocked(api.post).mock.calls.filter(([p]) => p === '/skills/remote/preview')
    expect(previews).toHaveLength(2)
  })

  it('disables sibling row Installs while one row install is in flight', async () => {
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'react-helper', description: 'Does react things', relativePath: 'skills/react-helper' }],
        })
      }
      // The install POST never resolves during the test window.
      return new Promise(() => {})
    })
    const { input } = await openSkillsTab({}, [
      catalogHit(),
      catalogHit({ id: 'hit-2', skillId: 'other-helper', name: 'other-helper' }),
    ])
    fireEvent.change(input, { target: { value: 'react' } })
    await waitFor(() => expect(addCard().getAllByRole('button', { name: 'Install' })).toHaveLength(2))

    fireEvent.click(addCard().getAllByRole('button', { name: 'Install' })[0]!)
    await waitFor(() => expect(addCard().getByText('Installing…')).toBeTruthy())
    const buttons = addCard().getAllByRole('button') as HTMLButtonElement[]
    const sibling = buttons.find((b) => b.textContent === 'Install')
    expect(sibling, 'sibling row Install').toBeTruthy()
    expect(sibling!.disabled).toBe(true)
  })

  it('a failed install does not move the target into the recent-projects MRU', async () => {
    // Only SUCCESS remembers the project — a rejected POST must not churn
    // the MRU shared with the New Session dialog.
    window.localStorage.setItem('claude-react-web:recent-cwds', JSON.stringify(['/seed/repo']))
    vi.mocked(api.post).mockRejectedValue(new Error('boom'))
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    fireEvent.click(addCard().getByRole('button', { name: 'Folder' }))
    fireEvent.change(addCard().getByLabelText('Server path to skill folder'), { target: { value: '/srv/skills/helper' } })
    fireEvent.click(addCard().getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(addCard().getByText('boom')).toBeTruthy())

    expect(JSON.parse(window.localStorage.getItem('claude-react-web:recent-cwds') ?? '[]')).toEqual(['/seed/repo'])
    window.localStorage.removeItem('claude-react-web:recent-cwds')
  })

  it('a fully-failed batch install does not write the MRU either', async () => {
    // The POST resolved but nothing landed — remembering the project would
    // pollute the MRU shared with the New Session dialog.
    window.localStorage.setItem('claude-react-web:recent-cwds', JSON.stringify(['/seed/repo']))
    stubTwoSkillPreview(() => ({
      installed: [],
      failed: [
        { name: 'alpha-skill', relativePath: 'skills/alpha-skill', error: 'Missing SKILL.md' },
        { name: 'beta-skill', relativePath: 'skills/beta-skill', error: 'Missing SKILL.md' },
      ],
    }))
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'org/repo' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Open repository' })).toBeTruthy())
    fireEvent.click(addCard().getByRole('button', { name: 'Open repository' }))
    await waitFor(() => expect(addCard().getByRole('checkbox', { name: /alpha-skill/ })).toBeTruthy())

    fireEvent.click(addCard().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(addCard().getByRole('button', { name: 'Install selected (1)' }))
    await waitFor(() => expect(addCard().getByText('0 installed · 2 failed')).toBeTruthy())

    expect(JSON.parse(window.localStorage.getItem('claude-react-web:recent-cwds') ?? '[]')).toEqual(['/seed/repo'])
    window.localStorage.removeItem('claude-react-web:recent-cwds')
  })

  it('disables install-affecting controls while a row install is in flight', async () => {
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'react-helper', description: 'Does react things', relativePath: 'skills/react-helper' }],
        })
      }
      return new Promise(() => {})
    })
    const { input } = await openSkillsTab({ defaults: { cwd: '/work/proj' } }, [
      catalogHit(),
      catalogHit({ id: 'hit-2', skillId: 'other-helper', name: 'other-helper' }),
    ])
    fireEvent.change(input, { target: { value: 'react' } })
    await waitFor(() => expect(addCard().getAllByRole('button', { name: 'Install' })).toHaveLength(2))

    fireEvent.click(addCard().getAllByRole('button', { name: 'Install' })[0]!)
    await waitFor(() => expect(addCard().getByText('Installing…')).toBeTruthy())

    // Footer controls claim to affect the in-flight install — disable them.
    expect((addCard().getByRole('button', { name: 'User' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Target project') as HTMLSelectElement).disabled).toBe(true)
    expect((addCard().getByLabelText('Replace existing') as HTMLInputElement).disabled).toBe(true)
    // And no repo switch may land mid-install (results would cross lists).
    expect((addCard().getAllByRole('button', { name: 'Open repo' })[1] as HTMLButtonElement).disabled).toBe(true)
  })

  it('blocks opening another repository while a batch install is in flight', async () => {
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'alpha-skill', description: 'Does alpha things', relativePath: 'skills/alpha-skill' }],
        })
      }
      return new Promise(() => {})
    })
    const { input } = await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    fireEvent.change(input, { target: { value: 'org/repo' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Open repository' })).toBeTruthy())
    fireEvent.click(addCard().getByRole('button', { name: 'Open repository' }))
    await waitFor(() => expect(addCard().getByRole('checkbox', { name: /alpha-skill/ })).toBeTruthy())

    fireEvent.click(addCard().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(addCard().getByRole('button', { name: 'Install selected (1)' }))
    await waitFor(() => expect(addCard().getByText('Installing…')).toBeTruthy())

    expect((addCard().getByRole('button', { name: 'Open repository' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Select All does not re-select rows that already succeeded', async () => {
    stubTwoSkillPreview(() => ({
      installed: [{ name: 'alpha-skill', relativePath: 'skills/alpha-skill' }],
      failed: [],
    }))
    const { input } = await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    fireEvent.change(input, { target: { value: 'org/repo' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Open repository' })).toBeTruthy())
    fireEvent.click(addCard().getByRole('button', { name: 'Open repository' }))
    await waitFor(() => expect(addCard().getByRole('checkbox', { name: /alpha-skill/ })).toBeTruthy())

    fireEvent.click(addCard().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(addCard().getByRole('button', { name: 'Install selected (1)' }))
    await waitFor(() => expect(addCard().getByText('✓')).toBeTruthy())

    // Select All must not drag the succeeded row back into the selection —
    // re-POSTing it would 409 and paint red over a correct install.
    fireEvent.click(addCard().getByRole('checkbox', { name: /Select All/ }))
    expect((addCard().getByRole('checkbox', { name: /alpha-skill/ }) as HTMLInputElement).checked).toBe(false)
    expect((addCard().getByRole('checkbox', { name: /beta-skill/ }) as HTMLInputElement).checked).toBe(true)
    expect(addCard().getByRole('button', { name: 'Install selected (1)' })).toBeTruthy()
  })

  it('a drop is only handled on the Folder body', async () => {
    vi.mocked(api.post).mockResolvedValue({
      skill: { scope: 'project', name: 'dropped', path: '/work/proj/.claude/skills/dropped', relativePath: 'dropped', description: '', valid: true, errors: [], content: '' },
      importedFiles: 1,
    })
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    const newFile = () => new File(['x'], 'SKILL.md', { type: 'text/markdown' })

    // The import handler is the only thing that calls preventDefault on a
    // drop, so defaultPrevented is a synchronous probe for "did the handler
    // see this drop?" — no FileReader timing involved.
    const searchBody = document.querySelector('.settings-skill-search-body')!
    const searchDrop = createEvent.drop(searchBody, { dataTransfer: { items: [], files: [newFile()] } })
    fireEvent(searchBody, searchDrop)
    expect(searchDrop.defaultPrevented, 'search-tab drop must not reach the import handler').toBe(false)

    fireEvent.click(addCard().getByRole('button', { name: 'Folder' }))
    const folderBody = document.querySelector('.settings-skill-folder-body')!
    const folderDrop = createEvent.drop(folderBody, { dataTransfer: { items: [], files: [newFile()] } })
    fireEvent(folderBody, folderDrop)
    expect(folderDrop.defaultPrevented).toBe(true)
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/import/files', expect.anything(), expect.anything()))
  })

  it('folder import errors do not bleed across tabs', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('boom'))
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    fireEvent.click(addCard().getByRole('button', { name: 'Folder' }))
    fireEvent.change(addCard().getByLabelText('Server path to skill folder'), { target: { value: '/srv/skills/helper' } })
    fireEvent.click(addCard().getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(addCard().getByText('boom')).toBeTruthy())

    fireEvent.click(addCard().getByRole('button', { name: 'Search catalog' }))
    expect(addCard().queryByText('boom')).toBeNull()
  })

  it('the Installed badge follows the target project', async () => {
    // "Installed this session" is per scope AND target — switching the
    // target project must return the row to Install so it can be installed
    // into the new project.
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'react-helper', description: 'Does react things', relativePath: 'skills/react-helper' }],
        })
      }
      return Promise.resolve({
        installed: [{ name: 'react-helper', relativePath: 'skills/react-helper' }],
        failed: [],
      })
    })
    window.localStorage.setItem('claude-react-web:recent-cwds', JSON.stringify(['/other/repo']))
    const { input } = await openSkillsTab({ defaults: { cwd: '/work/proj' } }, [catalogHit()])
    fireEvent.change(input, { target: { value: 'react' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Install' })).toBeTruthy())
    fireEvent.click(addCard().getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(addCard().getByText('✓ Installed')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Target project'), { target: { value: '/other/repo' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Install' })).toBeTruthy())
    expect(addCard().queryByText('✓ Installed')).toBeNull()
    window.localStorage.removeItem('claude-react-web:recent-cwds')
  })

  it('a drop is ignored while an install is in flight', async () => {
    // The busy gate covers non-button paths too — a drop must not start a
    // second POST into the same target.
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'alpha-skill', description: 'Does alpha things', relativePath: 'skills/alpha-skill' }],
        })
      }
      return new Promise(() => {})
    })
    const { input } = await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    fireEvent.change(input, { target: { value: 'org/repo' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Open repository' })).toBeTruthy())
    fireEvent.click(addCard().getByRole('button', { name: 'Open repository' }))
    await waitFor(() => expect(addCard().getByRole('checkbox', { name: /alpha-skill/ })).toBeTruthy())
    fireEvent.click(addCard().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(addCard().getByRole('button', { name: 'Install selected (1)' }))
    await waitFor(() => expect(addCard().getByText('Installing…')).toBeTruthy())

    fireEvent.click(addCard().getByRole('button', { name: 'Folder' }))
    const folderBody = document.querySelector('.settings-skill-folder-body')!
    const folderDrop = createEvent.drop(folderBody, {
      dataTransfer: { items: [], files: [new File(['x'], 'SKILL.md', { type: 'text/markdown' })] },
    })
    fireEvent(folderBody, folderDrop)
    // The handler must not even claim the drop (no preventDefault, no import).
    expect(folderDrop.defaultPrevented).toBe(false)
    expect(vi.mocked(api.post)).not.toHaveBeenCalledWith('/skills/import/files', expect.anything(), expect.anything())
  })

  it('a project-scope install POSTs the selected target cwd and remembers it', async () => {
    // Seed the MRU so the select offers a second project besides the server
    // default cwd, then point the target at it. '/other/repo' is seeded at
    // the TAIL deliberately: rememberCwd moves the used cwd to the head, so
    // the post-install order — not mere containment (already true from the
    // seed) — is what proves the success path remembered it.
    window.localStorage.setItem('claude-react-web:recent-cwds', JSON.stringify(['/seed/repo', '/other/repo']))
    stubTwoSkillPreview(() => ({
      installed: [{ name: 'alpha-skill', relativePath: 'skills/alpha-skill' }],
      failed: [],
    }))
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    const select = screen.getByLabelText('Target project') as HTMLSelectElement
    fireEvent.change(select, { target: { value: '/other/repo' } })

    // Install from the catalog via Open repository — the inline list must use
    // the card's effective cwd, not the server default.
    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'org/repo' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Open repository' })).toBeTruthy())
    fireEvent.click(addCard().getByRole('button', { name: 'Open repository' }))
    await waitFor(() => expect(addCard().getByRole('checkbox', { name: /alpha-skill/ })).toBeTruthy())

    fireEvent.click(addCard().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(addCard().getByRole('button', { name: 'Install selected (1)' }))
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/install', expect.objectContaining({ cwd: '/other/repo', scope: 'project' }), { timeoutMs: 60_000 }))

    // Success delivers onInstalled — the card must remember the project the
    // install landed in so the shared MRU offers it next time. The used cwd
    // moves to the MRU head.
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('claude-react-web:recent-cwds') ?? '[]')
      expect(stored).toContain('/other/repo')
      expect(stored[0]).toBe('/other/repo')
    })
    window.localStorage.removeItem('claude-react-web:recent-cwds')
  })

  it('shares one Replace existing control and passes it as overwrite', async () => {
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'react-helper', description: 'Does react things', relativePath: 'skills/react-helper' }],
        })
      }
      return Promise.resolve({ installed: [{ name: 'react-helper', relativePath: 'skills/react-helper' }], failed: [] })
    })
    await openSkillsTab({ defaults: { cwd: '/work/proj' } }, [catalogHit()])
    // Exactly one control in the whole card — not one per old section.
    expect(addCard().getAllByLabelText('Replace existing')).toHaveLength(1)

    fireEvent.click(addCard().getByRole('button', { name: 'Folder' }))
    expect(addCard().getAllByLabelText('Replace existing')).toHaveLength(1)

    // Back to the search tab (a fresh input — bodies unmount on switch) and
    // install from a row with the shared checkbox ticked.
    fireEvent.click(addCard().getByRole('button', { name: 'Search catalog' }))
    fireEvent.change(addCard().getByLabelText('Search skills'), { target: { value: 'react' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Install' })).toBeTruthy())
    fireEvent.click(addCard().getByLabelText('Replace existing'))
    fireEvent.click(addCard().getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/install', expect.objectContaining({ overwrite: true }), { timeoutMs: 60_000 }))
  })

  it('shows a target-project selector defaulting to the server default cwd', async () => {
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    const select = screen.getByLabelText('Target project') as HTMLSelectElement
    expect(select.value).toBe('/work/proj')
    expect(select.disabled).toBe(false)
    // Resolved target hint is visible in project scope.
    expect(screen.getByText('/work/proj/.claude/skills')).toBeTruthy()
  })

  it('disables the target selector in user scope', async () => {
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    fireEvent.click(addCard().getByRole('button', { name: 'User' }))
    const select = screen.getByLabelText('Target project') as HTMLSelectElement
    expect(select.disabled).toBe(true)
    // Hint disappears — user scope has no per-project target.
    expect(screen.queryByText('/work/proj/.claude/skills')).toBeNull()
  })

  it('selector onChange updates the target value and hint', async () => {
    // Seed the MRU list so the select offers a second path besides the
    // server default cwd.
    window.localStorage.setItem('claude-react-web:recent-cwds', JSON.stringify(['/other/repo']))
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    const select = screen.getByLabelText('Target project') as HTMLSelectElement
    fireEvent.change(select, { target: { value: '/other/repo' } })
    expect(select.value).toBe('/other/repo')
    expect(screen.getByText('/other/repo/.claude/skills')).toBeTruthy()
    window.localStorage.removeItem('claude-react-web:recent-cwds')
  })

  it('browse opens the directory picker and a pick becomes the target', async () => {
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })

    // DirectoryPicker browses the server filesystem; layer /fs shapes over
    // the shared config mock so the picker's bootstrap listing resolves.
    const baseGet = vi.mocked(api.get).getMockImplementation()!
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/fs/home') return Promise.resolve({ home: '/home/u', cwd: '/work/proj', sep: '/' })
      if (url.startsWith('/fs/list')) {
        const p = new URLSearchParams(url.split('?')[1]).get('path') ?? ''
        return Promise.resolve({ path: p, parent: null, entries: [] })
      }
      return baseGet(url)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Browse projects' }))
    await waitFor(() => expect(screen.getByText('Pick a project')).toBeTruthy())

    // Wait out the picker's initial directory listing so no in-flight
    // loadList can clobber the draft we are about to type.
    const dialog = screen.getByText('Pick a project').closest('.modal') as HTMLElement
    await waitFor(() => expect(within(dialog).queryByText('Loading...')).toBeNull())

    // Pick a different directory via the picker's manual-path affordance.
    const draftInput = within(dialog).getByRole('textbox') as HTMLInputElement
    fireEvent.change(draftInput, { target: { value: '/other/repo' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install skills here' }))

    await waitFor(() => expect(screen.queryByText('Pick a project')).toBeNull())
    const select = screen.getByLabelText('Target project') as HTMLSelectElement
    expect(select.value).toBe('/other/repo')
    expect(screen.getByText('/other/repo/.claude/skills')).toBeTruthy()
    window.localStorage.removeItem('claude-react-web:recent-cwds')
  })

  it('hides the footer install button in the search tab and shows it per tab', async () => {
    await openSkillsTab({})
    // Search tab: installs live on the result rows, no footer primary button.
    expect(addCard().queryByRole('button', { name: 'Install selected (0)' })).toBeNull()

    fireEvent.click(addCard().getByRole('button', { name: 'Repository' }))
    const batchBtn = addCard().getByRole('button', { name: 'Install selected (0)' }) as HTMLButtonElement
    expect(batchBtn.disabled).toBe(true)

    fireEvent.click(addCard().getByRole('button', { name: 'Folder' }))
    expect(addCard().getByRole('button', { name: 'Install' })).toBeTruthy()
  })

  it('offers import name only on the Folder tab', async () => {
    await openSkillsTab({})
    expect(addCard().queryByLabelText('Import name')).toBeNull()
    fireEvent.click(addCard().getByRole('button', { name: 'Repository' }))
    expect(addCard().queryByLabelText('Import name')).toBeNull()
    fireEvent.click(addCard().getByRole('button', { name: 'Folder' }))
    expect(addCard().getByLabelText('Import name')).toBeTruthy()
  })

  it('server-path install POSTs the folder import with name and overwrite', async () => {
    vi.mocked(api.post).mockResolvedValue({
      skill: { scope: 'project', name: 'my-helper', path: '/work/proj/.claude/skills/my-helper', relativePath: 'my-helper', description: 'helper', valid: true, errors: [], content: '' },
      importedFiles: 3,
    })
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    fireEvent.click(addCard().getByRole('button', { name: 'Folder' }))

    fireEvent.change(addCard().getByLabelText('Server path to skill folder'), { target: { value: '/srv/skills/helper' } })
    fireEvent.change(addCard().getByLabelText('Import name'), { target: { value: 'my-helper' } })
    fireEvent.click(addCard().getByLabelText('Replace existing'))
    fireEvent.click(addCard().getByRole('button', { name: 'Install' }))

    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/import/path', {
      scope: 'project',
      cwd: '/work/proj',
      path: '/srv/skills/helper',
      name: 'my-helper',
      overwrite: true,
    }, expect.anything()))
  })

  it('refreshes the installed list when a batch install lands after the modal closes', async () => {
    // Cancel / closing the settings modal mid-install must not strand the
    // POST: it lands on disk anyway, so when it resolves the refresh has to
    // happen regardless (the GET is the source of truth).
    let resolveInstall!: () => void
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'alpha-skill', description: 'Does alpha things', relativePath: 'skills/alpha-skill' }],
        })
      }
      return new Promise((resolve) => {
        resolveInstall = () => resolve({
          installed: [{ name: 'alpha-skill', relativePath: 'skills/alpha-skill' }],
          failed: [],
        })
      })
    })
    const { input, view } = await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    fireEvent.change(input, { target: { value: 'org/repo' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Open repository' })).toBeTruthy())
    fireEvent.click(addCard().getByRole('button', { name: 'Open repository' }))
    await waitFor(() => expect(addCard().getByRole('checkbox', { name: /alpha-skill/ })).toBeTruthy())

    fireEvent.click(addCard().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(addCard().getByRole('button', { name: 'Install selected (1)' }))
    // Close the whole settings modal while the POST is still pending…
    view.unmount()
    // …then let it land: the list must refresh even though the UI is gone.
    const listsBefore = listGets().length
    resolveInstall()
    await waitFor(() => expect(listGets().length).toBeGreaterThan(listsBefore))
  })

  it('still refreshes the installed list when the batch POST fails after close', async () => {
    // A rejected POST after the modal is gone must not be swallowed silently:
    // the list refreshes because files may have landed before the failure.
    let rejectInstall!: () => void
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'alpha-skill', description: 'Does alpha things', relativePath: 'skills/alpha-skill' }],
        })
      }
      return new Promise((_resolve, reject) => {
        rejectInstall = () => reject(new Error('boom'))
      })
    })
    const { input, view } = await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    fireEvent.change(input, { target: { value: 'org/repo' } })
    await waitFor(() => expect(addCard().getByRole('button', { name: 'Open repository' })).toBeTruthy())
    fireEvent.click(addCard().getByRole('button', { name: 'Open repository' }))
    await waitFor(() => expect(addCard().getByRole('checkbox', { name: /alpha-skill/ })).toBeTruthy())

    fireEvent.click(addCard().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(addCard().getByRole('button', { name: 'Install selected (1)' }))
    view.unmount()
    const listsBefore = listGets().length
    rejectInstall()
    await waitFor(() => expect(listGets().length).toBeGreaterThan(listsBefore))
  })
})
