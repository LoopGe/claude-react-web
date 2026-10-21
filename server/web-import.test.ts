import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from './__test-utils__/index.js'
import { readSourceCredentials, readSourceMcp, readSourceMarketplaces } from './web-import.js'

/** 网页版的 config.json：active profile 是数组里的第二条（用户切换过），
 *  第一条是旧的、带一个假 token —— 导入必须认 active 那条。 */
function seedSourceConfig(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    profiles: [
      { id: 'old', name: 'Old', authToken: 'sk-ant-old', baseUrl: 'https://old.example.com', modelList: ['old-model'] },
      { id: 'work', name: 'Work', authToken: 'sk-ant-work1234', baseUrl: 'https://work.example.com/', modelList: ['m-a', 'm-b'] },
    ],
    activeProfileId: 'work',
  }), 'utf8')
}

describe('readSourceCredentials', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('web-import-src') })
  afterEach(() => rmRf(dir))

  it('resolves the ACTIVE profile, not profiles[0]', async () => {
    seedSourceConfig(dir)
    const cred = await readSourceCredentials(dir)
    expect(cred.profileName).toBe('Work')
    expect(cred.authToken).toBe('sk-ant-work1234')
    expect(cred.modelList).toEqual(['m-a', 'm-b'])
  })

  it('normalizes a trailing slash off baseUrl (same rule the reader uses)', async () => {
    seedSourceConfig(dir)
    const cred = await readSourceCredentials(dir)
    expect(cred.baseUrl).toBe('https://work.example.com')
  })

  it('reports absence per field — a missing recapModel is NOT present', async () => {
    seedSourceConfig(dir)
    const cred = await readSourceCredentials(dir)
    expect(cred.present.authToken).toBe(true)
    expect(cred.present.modelList).toBe(true)
    expect(cred.present.recapModel).toBe(false)
    expect(cred.present.commitMessageModel).toBe(false)
  })

  it('throws when the source config.json is missing', async () => {
    await expect(readSourceCredentials(dir)).rejects.toThrow(/config\.json/)
  })

  it('throws when the source config.json is not a JSON object', async () => {
    writeFileSync(join(dir, 'config.json'), '["not", "an", "object"]', 'utf8')
    await expect(readSourceCredentials(dir)).rejects.toThrow()
  })
})

describe('readSourceMcp / readSourceMarketplaces', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('web-import-src') })
  afterEach(() => rmRf(dir))

  it('returns [] when the files are absent (never throws)', async () => {
    expect(await readSourceMcp(dir)).toEqual([])
    expect(await readSourceMarketplaces(dir)).toEqual({ entries: [], enabled: {}, cloneExists: {} })
  })

  it('loads MCP servers with their secrets intact server-side', async () => {
    // 磁盘形状是 keyed object（key = name），见 McpConfigStore.parseItems；
    // `{version, servers}` 是导出信封 McpExportFile，不是 state 目录里的文件。
    writeFileSync(join(dir, 'mcp-config.json'), JSON.stringify({
      ctx7: { name: 'ctx7', type: 'stdio', command: 'npx', env: { API_KEY: 'sekret' }, enabled: true },
    }), 'utf8')
    const servers = await readSourceMcp(dir)
    expect(servers.map((s) => s.name)).toEqual(['ctx7'])
    expect(servers[0].env).toEqual({ API_KEY: 'sekret' })
  })
})