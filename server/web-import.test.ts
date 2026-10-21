import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tempDir, rmRf } from './__test-utils__/index.js'
import { MANIFEST_REL_PATH } from './marketplace-parser.js'
import { MpStore } from './mp-store.js'
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
    await expect(readSourceCredentials(dir)).rejects.toThrow(/not a JSON object/)
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

  // 损坏 ≠ 没有。store 会把两者都折叠成空值+warn，导入页于是只说"没有可
  // 导入的东西"，用户只好手敲一遍——正是这个功能要消灭的场景。
  it('throws when mcp-config.json exists but is not valid JSON', async () => {
    writeFileSync(join(dir, 'mcp-config.json'), '{not json', 'utf8')
    await expect(readSourceMcp(dir)).rejects.toThrow(/mcp-config\.json is not valid JSON/)
  })

  it('throws when marketplaces.json exists but is not valid JSON', async () => {
    writeFileSync(join(dir, 'marketplaces.json'), '{not json', 'utf8')
    await expect(readSourceMarketplaces(dir)).rejects.toThrow(/marketplaces\.json is not valid JSON/)
  })

  // 刻意与上两条相反：合法 JSON 只是形状不对（顶层不是对象），交给 store 的
  // 宽容路径 → 空值。这条不对称是设计，别"统一"成 throw。
  it('stays tolerant (empty) for valid JSON with an unexpected shape', async () => {
    writeFileSync(join(dir, 'mcp-config.json'), '"just a string"', 'utf8')
    writeFileSync(join(dir, 'marketplaces.json'), '[]', 'utf8')
    expect(await readSourceMcp(dir)).toEqual([])
    expect(await readSourceMarketplaces(dir)).toEqual({ entries: [], enabled: {}, cloneExists: {} })
  })
})

/** 两个市场：`alpha` 的 clone 存在、启用了 `shared`；`beta` 的 cloneDir
 *  刻意不存在、启用了 `other`。enabledPlugins 用 `<plugin>@<marketplace>`
 *  复合 key —— 两个 key 的插件名不同，才能钉住"每个市场只看自己那条"，
 *  否则两边返回同一个 map 也照样通过。 */
function seedTwoMarketplaces(dir: string): void {
  const alphaClone = join(dir, 'marketplace-cache', 'alpha')
  mkdirSync(alphaClone, { recursive: true })
  const entry = (id: string, sha: string, cloneDir: string) => ({
    id,
    displayName: id,
    source: { type: 'https', url: `https://example.com/${id}.git` },
    cloneDir,
    addedAt: 1_700_000_000_000,
    lastRefreshedAt: 1_700_000_000_000,
    lastSha: sha.repeat(40),
    manifest: { name: id, plugins: [{ name: 'shared' }] },
  })
  writeFileSync(join(dir, 'marketplaces.json'), JSON.stringify({
    version: 1,
    marketplaces: {
      alpha: entry('alpha', 'a', alphaClone),
      beta: entry('beta', 'b', join(dir, 'marketplace-cache', 'beta')),
    },
    enabledPlugins: { 'shared@alpha': true, 'other@beta': true },
  }), 'utf8')
}

describe('readSourceMarketplaces side state', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('web-import-src') })
  afterEach(() => rmRf(dir))

  it('reports each marketplace’s enabled plugins and clone existence', async () => {
    seedTwoMarketplaces(dir)
    const res = await readSourceMarketplaces(dir)
    expect(res.entries.map((e) => e.id)).toEqual(['alpha', 'beta'])
    // 复合 key 按 `@<marketplace>` 归属：各自只看到自己那条，不串味。
    expect(res.enabled.alpha).toEqual({ shared: true })
    expect(res.enabled.beta).toEqual({ other: true })
    expect(res.cloneExists).toEqual({ alpha: true, beta: false })
  })
})

/** 造一个"缓存 manifest 相对 clone 已过期"的源目录：clone 里 manifest.name
 *  是 `official`，而 marketplaces.json 缓存的是 `old official` + 另一个插件。
 *  MpStore 的自愈正是为这种漂移准备的——默认 load() 会重解析并回写文件。 */
function seedStaleMarketplace(dir: string): string {
  const cloneDir = join(dir, 'marketplace-cache', 'official')
  const manifestPath = join(cloneDir, MANIFEST_REL_PATH)
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, JSON.stringify({
    name: 'official',
    plugins: [{ name: 'brand-new' }],
  }), 'utf8')
  const file = join(dir, 'marketplaces.json')
  writeFileSync(file, JSON.stringify({
    version: 1,
    marketplaces: {
      official: {
        id: 'official',
        displayName: 'old official',
        source: { type: 'https', url: 'https://example.com/official.git' },
        cloneDir,
        addedAt: 1_700_000_000_000,
        lastRefreshedAt: 1_700_000_000_000,
        lastSha: 'a'.repeat(40),
        manifest: { name: 'old official', plugins: [{ name: 'stale-local' }] },
      },
    },
    enabledPlugins: {},
  }), 'utf8')
  return file
}

describe('readSourceMarketplaces is read-only', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('web-import-src') })
  afterEach(() => rmRf(dir))

  // 没有这条对照，下面那条"文件没变"可能只是因为 fixture 根本没触发自愈。
  it('the fixture really does trigger the self-heal on the DEFAULT load path', async () => {
    const file = seedStaleMarketplace(dir)
    const before = readFileSync(file, 'utf8')

    await new MpStore({ stateDir: dir }).load()

    expect(readFileSync(file, 'utf8')).not.toBe(before)
  })

  it('leaves the source marketplaces.json byte-identical when the cache is stale', async () => {
    const file = seedStaleMarketplace(dir)
    const before = readFileSync(file, 'utf8')
    const mtimeBefore = statSync(file).mtimeMs

    const res = await readSourceMarketplaces(dir)

    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(statSync(file).mtimeMs).toBe(mtimeBefore)
    // 代价（刻意如此）：跳过自愈意味着过期缓存被原样返回，而不是被修复。
    expect(res.entries[0].displayName).toBe('old official')
    expect(res.cloneExists.official).toBe(true)
  })
})
