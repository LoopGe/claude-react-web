import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from './ToastProvider'
import { GlobalSettingsModal } from './GlobalSettingsModal'
import { api } from '../hooks/useApi'
import { gitToolsInfo, mockGet } from '../test-utils/settings-fixtures'
import type { SkillRecord, SkillScope } from '../../shared/skills'

vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }))

vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))

const remoteSkill = (scope: SkillScope, name: string, lastSha = 'sha-1'): SkillRecord => ({
  scope,
  name,
  description: 'demo skill',
  path: `/x/${name}/SKILL.md`,
  relativePath: `${name}/SKILL.md`,
  readOnly: false,
  valid: true,
  errors: [],
  source: { source: 'acme/repo-a', relativePath: `skills/${name}`, lastSha },
})

const localSkill = (scope: SkillScope, name: string): SkillRecord => ({
  scope,
  name,
  description: 'local skill',
  path: `/x/${name}/SKILL.md`,
  relativePath: `${name}/SKILL.md`,
  readOnly: false,
  valid: true,
  errors: [],
})

const projectSkillAt = (name: string, projectRoot: string): SkillRecord => ({
  ...localSkill('project', name),
  path: `${projectRoot}/.claude/skills/${name}/SKILL.md`,
  relativePath: `.claude/skills/${name}/SKILL.md`,
})

/** Render the Skills tab with the given installed skills, and optionally the
 *  api.post router for check-updates / update. */
async function openSkillsWithInstalled(
  installed: SkillRecord[],
  postImpl?: (path: string, body?: unknown) => Promise<unknown>,
) {
  mockGet({ defaults: { cwd: '/work/proj' } }, [gitToolsInfo])
  const baseGet = vi.mocked(api.get).getMockImplementation()!
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === '/skills' || url.startsWith('/skills?')) return Promise.resolve({ skills: installed })
    return baseGet(url)
  })
  if (postImpl) vi.mocked(api.post).mockImplementation(postImpl)
  render(
    <ToastProvider>
      <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
    </ToastProvider>,
  )
  await waitFor(() => expect(screen.getByText('Extensions')).toBeTruthy())
  fireEvent.click(screen.getByText('Extensions'))
  await waitFor(() => expect(screen.getByLabelText('Search skills')).toBeTruthy())
}

const rowOf = (name: string, scope: SkillScope) => {
  const row = screen.getAllByText(name)
    .map((el) => el.closest('.settings-skill-item') ?? el.closest('.settings-skill-row'))
    .find((el) => el && el.textContent!.includes(scope))
  if (!row) throw new Error(`row not found: ${scope}:${name}`)
  return row as HTMLElement
}

const checkUpdatesBody = (scope: SkillScope, updates: unknown) =>
  scope === 'project' ? { updates } : { updates: [] }

describe('GlobalSettingsModal Skills update checks', () => {
  beforeEach(() => {
    vi.mocked(api.put).mockResolvedValue({})
    vi.mocked(api.post).mockReset()
    vi.mocked(api.get).mockClear()
  })

  it('badges project rows with the owning project directory', async () => {
    // The row's relativePath is project-relative, so the owning project is
    // otherwise invisible — the badge derives it from the absolute path.
    await openSkillsWithInstalled([
      projectSkillAt('find-skills', '/Users/loop/Codes/claude-react-web'),
      localSkill('user', 'home-skill'),
    ])
    await waitFor(() => expect(screen.getByText('find-skills')).toBeTruthy())

    const badge = screen.getByText('claude-react-web')
    expect(badge.getAttribute('title')).toBe('/Users/loop/Codes/claude-react-web')
    // User-scope rows carry no project badge.
    const userRow = rowOf('home-skill', 'user')
    expect(userRow.textContent).not.toContain('claude-react-web')
  })

  it('Check for updates queries both scopes and badges only hasUpdate rows', async () => {
    await openSkillsWithInstalled(
      [remoteSkill('project', 'pdf'), localSkill('project', 'local-one')],
      (path, body) => {
        if (path === '/skills/check-updates') {
          const scope = (body as { scope: SkillScope }).scope
          if (scope === 'project') return Promise.resolve(checkUpdatesBody('project', [{ scope: 'project', name: 'pdf', hasUpdate: true, remoteSha: 'sha-2' }]))
          return Promise.resolve({ updates: [] })
        }
        return Promise.resolve({ installed: [], failed: [] })
      },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    await waitFor(() => expect(screen.getByText('Update available')).toBeTruthy())

    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/check-updates', { scope: 'project', cwd: '/work/proj' })
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/check-updates', { scope: 'user', cwd: undefined })
    // The folder-imported row gets no update UI at all.
    expect(rowOf('local-one', 'project').textContent).not.toContain('Update available')
    expect(rowOf('local-one', 'project').textContent).not.toContain('Update')
  })

  it('Update posts the update, clears the badge and refreshes', async () => {
    await openSkillsWithInstalled(
      [remoteSkill('project', 'pdf')],
      (path) => {
        if (path === '/skills/check-updates') {
          return Promise.resolve(checkUpdatesBody('project', [{ scope: 'project', name: 'pdf', hasUpdate: true, remoteSha: 'sha-2' }]))
        }
        if (path === '/skills/remote/update') {
          return Promise.resolve({ skill: remoteSkill('project', 'pdf', 'sha-2'), lastSha: 'sha-2' })
        }
        return Promise.resolve({ installed: [], failed: [] })
      },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    await waitFor(() => expect(screen.getByText('Update available')).toBeTruthy())
    const listsBefore = vi.mocked(api.get).mock.calls.filter(([u]) => String(u).startsWith('/skills?') || u === '/skills').length

    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/update', { scope: 'project', cwd: '/work/proj', name: 'pdf' }))
    await waitFor(() => expect(screen.queryByText('Update available')).toBeNull())

    const listsAfter = vi.mocked(api.get).mock.calls.filter(([u]) => String(u).startsWith('/skills?') || u === '/skills').length
    expect(listsAfter).toBeGreaterThan(listsBefore)
  })

  it('does not cross badges between same-named skills in different scopes', async () => {
    await openSkillsWithInstalled(
      [remoteSkill('project', 'pdf'), remoteSkill('user', 'pdf')],
      (path, body) => {
        if (path === '/skills/check-updates') {
          const scope = (body as { scope: SkillScope }).scope
          if (scope === 'project') return Promise.resolve({ updates: [{ scope: 'project', name: 'pdf', hasUpdate: true, remoteSha: 'sha-2' }] })
          return Promise.resolve({ updates: [{ scope: 'user', name: 'pdf', hasUpdate: false, remoteSha: 'sha-1' }] })
        }
        return Promise.resolve({ installed: [], failed: [] })
      },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    await waitFor(() => expect(screen.getByText('Update available')).toBeTruthy())
    expect(rowOf('pdf', 'project').textContent).toContain('Update available')
    expect(rowOf('pdf', 'user').textContent).not.toContain('Update available')
  })

  it('shows a check failure inline on the affected row', async () => {
    await openSkillsWithInstalled(
      [remoteSkill('project', 'pdf')],
      (path) => {
        if (path === '/skills/check-updates') {
          return Promise.resolve({ updates: [{ scope: 'project', name: 'pdf', hasUpdate: false, error: 'boom' }] })
        }
        return Promise.resolve({ installed: [], failed: [] })
      },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
  })
})
