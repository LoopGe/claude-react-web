// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { createServer } from 'vite'

describe('registry HMR boundary', () => {
  it('registers the literal self-accepting callback Vite requires for a full reload', async () => {
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, watch: null },
    })
    try {
      const transformed = await server.transformRequest('/src/session-store/registry.ts')

      expect(transformed?.code).toMatch(/import\.meta\.hot\.accept\s*\(/)
      expect(transformed?.code).toContain('window.location.reload')

      const module = await server.moduleGraph.getModuleByUrl('/src/session-store/registry.ts')
      expect(module?.isSelfAccepting).toBe(true)
      expect(
        [...module!.importedModules].some((dependency) =>
          dependency.url.endsWith('/src/session-store/store.ts'),
        ),
      ).toBe(true)
    } finally {
      await server.close()
    }
  }, 30_000)
})
