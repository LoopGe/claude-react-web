import { describe, expect, it } from 'vitest'
import { buildFirstPartyRouter } from './first-party.js'
import { APP_TOOLS_SERVER_NAME } from '../sdk-tools/app-tools.js'

describe('GET /first-party-tools', () => {
  it('serves the registry static tool listing (15 apptools tools, 4 read-only)', async () => {
    const res = await buildFirstPartyRouter().request('/first-party-tools')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      servers: Array<{ name: string; description: string; tools: Array<{ name: string; description: string; readOnly: boolean }> }>
    }
    const apptools = body.servers.find((s) => s.name === APP_TOOLS_SERVER_NAME)!
    expect(apptools.description).toBeTruthy()
    expect(apptools.tools).toHaveLength(15)
    expect(apptools.tools.filter((t) => t.readOnly).map((t) => t.name))
      .toEqual(['git_status', 'git_branches', 'git_stashes', 'git_log'])
  })
})
