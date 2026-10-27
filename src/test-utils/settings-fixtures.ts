// Shared fixtures for GlobalSettingsModal test suites: the api.get URL router
// and the static first-party registry listing. One copy so a route change is
// patched in one place.
import { vi } from 'vitest'
import { api } from '../hooks/useApi'
import type { RemoteSearchHit } from '../../shared/skills'

// Static registry listing as GET /first-party-tools serves it.
export const gitToolsInfo = {
  name: 'git-tools',
  description: 'First-party git tools bound to the session cwd',
  tools: [
    { name: 'git_status', description: 'Show git working-tree status.', readOnly: true },
    { name: 'git_stage', description: 'Stage files into the index.', readOnly: false },
  ],
}

// api.get is called for /config/full, /mcp-config and /first-party-tools — route by URL.
export function mockGet(config: Record<string, unknown>, fpServers: unknown[] = [gitToolsInfo], searchSkills: RemoteSearchHit[] = []) {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === '/mcp-config') return Promise.resolve({ servers: [] })
    if (url === '/first-party-tools') return Promise.resolve({ servers: fpServers })
    // LogsTab is reachable by landing on the System group's first leaf, so
    // the /log shape it reads at mount must always be present.
    if (url === '/log') return Promise.resolve({ level: 'info', availableLevels: ['error', 'warn', 'info', 'debug', 'trace'] })
    if (url === '/log/file') return Promise.resolve({ enabled: false, path: null })
    // Catalog search — distinct from the installed-list fetch (/skills?…)
    // only by the `/search` segment, so match it before any /skills fallthrough.
    if (url.startsWith('/skills/search')) return Promise.resolve({ skills: searchSkills })
    return Promise.resolve(config)
  })
}
