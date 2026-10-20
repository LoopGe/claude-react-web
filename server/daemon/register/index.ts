// One decision point for "which OS autostart mechanism applies here". The
// result is cached: the platform never changes mid-process.
//
// Platform adapters land in Tasks 5–7; until each one exists its branch
// returns a stub that fails loudly, keeping every commit typecheck-green.
import type { PlatformRegister } from './types.js'
import { WindowsRegister } from './windows.js'

let cached: PlatformRegister | null = null

export function getPlatformRegister(): PlatformRegister {
  if (cached) return cached
  let platform: PlatformRegister
  switch (process.platform) {
    case 'win32':
      platform = new WindowsRegister()
      break
    case 'darwin':
      platform = stubRegister('launchd')
      break
    default:
      platform = stubRegister('systemd')
      break
  }
  cached = platform
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
