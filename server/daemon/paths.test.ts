import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { distDirOf, resolveDaemonEntryPaths, daemonLogPaths } from './paths.js'

describe('daemon paths', () => {
  it('daemon log paths live under <stateDir>/daemon', () => {
    const p = daemonLogPaths('/tmp/state')
    expect(p.daemonLog).toBe(join('/tmp/state', 'daemon', 'daemon.log'))
    expect(p.serverLog).toBe(join('/tmp/state', 'daemon', 'server.log'))
  })

  it('rejects a non-bundled runtime (tsx dev) with an actionable message', () => {
    // This test process IS tsx/vitest — resolveDaemonEntryPaths must refuse.
    expect(() => resolveDaemonEntryPaths()).toThrow(/npm run build/)
  })

  it('distDirOf: BOTH production entry bundles resolve to the same dist dir', () => {
    // Regression (review, empirical esbuild probe): import.meta.url inside
    // dist/cli.mjs IS cli.mjs — the predicate must accept it too, or every
    // gate fires in production and the feature dies in its own bundle.
    const dir = distDirOf('D:/app/dist/cli.mjs')
    expect(dir).toBe('D:/app/dist')
    expect(distDirOf('D:/app/dist/daemon.mjs')).toBe('D:/app/dist')
    expect(distDirOf('D:\\app\\dist\\cli.mjs')).toBe('D:/app/dist') // Windows separators
  })

  it('distDirOf: repo paths under a .../dist/... directory are NOT bundled', () => {
    expect(distDirOf('D:/work/dist/claude-react-web/server/daemon/paths.ts')).toBeNull()
    expect(distDirOf('D:/app/dist/client/index.html')).toBeNull()
    expect(distDirOf('D:/app/src/daemon/paths.ts')).toBeNull()
  })
})
