import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

describe('official App Plugin marketplace catalog', () => {
  const catalog = JSON.parse(readFileSync(join(here, 'app-plugins-marketplace.json'), 'utf8')) as {
    appPlugins: Array<{ name: string; dir: string }>
  }

  it('every catalog entry points at a directory with a crw-plugin.json', () => {
    expect(catalog.appPlugins.length).toBeGreaterThan(0)
    for (const entry of catalog.appPlugins) {
      expect(existsSync(join(here, entry.dir, 'crw-plugin.json')), `missing crw-plugin.json for ${entry.dir}`).toBe(true)
    }
  })
})
