import { posix, win32 } from 'node:path'

/** Join paths for the OS being probed, not the OS running the tests/server.
 * Forward slashes are valid on Windows and keep POSIX fixtures/host-independent
 * launch definitions stable across platforms. */
export function joinForPlatform(platformName: string, ...segments: string[]): string {
  if (platformName === 'win32') return win32.join(...segments).replaceAll('\\', '/')
  return posix.join(...segments)
}
