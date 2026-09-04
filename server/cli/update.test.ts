import { describe, it, expect, vi } from 'vitest'

vi.mock('../update-checker.js', () => ({
  checkForUpdates: vi.fn(async () => ({
    current: '1.0.0', packageName: 'claude-react-web', installMethod: 'npx', hasUpdate: false, source: 'npm',
  })),
}))

import { updateGroup } from './update.js'
import { parseArgs } from './parser.js'

describe('update group', () => {
  it('returns update info', async () => {
    const data = await updateGroup.default!.run({ stateDir: '' }, parseArgs([]))
    expect((data as { hasUpdate: boolean }).hasUpdate).toBe(false)
    expect(updateGroup.default!.render(data)).toContain('1.0.0')
  })
})
