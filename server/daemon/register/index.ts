// One decision point for "which OS autostart mechanism applies here". The
// result is cached: the platform never changes mid-process.
//
// Platform adapters land in Tasks 5–7; until each one exists its branch
// returns a stub that fails loudly, keeping every commit typecheck-green.
import type { PlatformRegister } from './types.js'

let cached: PlatformRegister | null = null

export function getPlatformRegister(): PlatformRegister {
  if (cached) return cached
  switch (process.platform) {
    case 'win32':
      cached = stubRegister('schtasks')
      break
    case 'darwin':
      cached = stubRegister('launchd')
      break
    default:
      cached = stubRegister('systemd')
      break
  }
  return cached
}

function stubRegister(mechanism: PlatformRegister['mechanism']): PlatformRegister {
  const fail = (op: string): never => { throw new Error(`not implemented: ${mechanism}.${op}`) }
  return {
    mechanism,
    isSupported: async () => fail('isSupported'),
    register: async () => fail('register'),
    unregister: async () => fail('unregister'),
    query: async () => fail('query'),
  }
}
