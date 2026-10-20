// One decision point for "which OS autostart mechanism applies here". The
// result is cached: the platform never changes mid-process.
//
// Platform adapters land in Tasks 5–7; until each one exists its branch
// returns a stub that fails loudly, keeping every commit typecheck-green.
import type { PlatformRegister } from './types.js'
import { WindowsRegister } from './windows.js'
import { MacosRegister } from './macos.js'
import { LinuxRegister } from './linux.js'

let cached: PlatformRegister | null = null

export function getPlatformRegister(): PlatformRegister {
  if (cached) return cached
  let platform: PlatformRegister
  switch (process.platform) {
    case 'win32':
      platform = new WindowsRegister()
      break
    case 'darwin':
      platform = new MacosRegister()
      break
    default:
      platform = new LinuxRegister()
      break
  }
  cached = platform
  return cached
}
