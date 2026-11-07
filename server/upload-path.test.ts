import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { uploadEntryPathContained } from './upload-path.js'

describe('uploadEntryPathContained', () => {
  const entryBase = { id: 'u', cwd: '', name: 'a.txt', size: 1, uploadedAt: 1, sessionTitle: '' }

  it('accepts the legacy and v1 roots and rejects outside paths', () => {
    const stateDir = resolve('C:/state')
    const legacy = { ...entryBase, path: join(stateDir, 'claude-web-uploads', 'a.txt'), cwd: stateDir }
    const v1 = { ...legacy, path: join(stateDir, 'claude-web-attachments', 'v1', 'files', 'ab', 'a.txt') }
    expect(uploadEntryPathContained(legacy, stateDir)).toBe(true)
    expect(uploadEntryPathContained(v1, stateDir)).toBe(true)
    expect(uploadEntryPathContained({ ...legacy, path: 'C:/elsewhere/a.txt' }, stateDir)).toBe(false)
  })

  it('accepts a session-owned legacy upload dir under its own cwd', () => {
    const stateDir = resolve('C:/state')
    const sessionCwd = resolve('C:/work')
    const own = { ...entryBase, cwd: sessionCwd, path: join(sessionCwd, 'claude-web-uploads', 'a.txt') }
    expect(uploadEntryPathContained(own, stateDir)).toBe(true)
  })

  it('rejects a sibling directory that only shares a name prefix', () => {
    const stateDir = resolve('C:/state')
    const entry = {
      ...entryBase,
      cwd: stateDir,
      path: join(stateDir, 'claude-web-attachments-evil', 'a.txt'),
    }
    expect(uploadEntryPathContained(entry, stateDir)).toBe(false)
  })
})
