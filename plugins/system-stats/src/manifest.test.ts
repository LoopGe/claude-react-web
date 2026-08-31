import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateManifest } from '../../../shared/app-plugins/manifest-validator.js'

const here = dirname(fileURLToPath(import.meta.url))

describe('system-stats manifest', () => {
  const manifest = JSON.parse(readFileSync(join(here, '..', 'crw-plugin.json'), 'utf8'))

  it('validates with the widget contribution intact', () => {
    const r = validateManifest(manifest, { hostVersion: '0.7.0', hostNodeMajor: 20 })
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.contributions?.widgets).toHaveLength(1)
    expect(r.contributions?.widgets?.[0].id).toBe('system-stats.claude-react-web.overview')
    expect(r.contributions?.widgets?.[0].location).toBe('global.bottomLeft')
    expect(r.contributions?.widgets?.[0].kind).toBe('stat-grid')
  })
})
