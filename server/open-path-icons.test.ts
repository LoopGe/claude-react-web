// Tests for the open-path icon extractors — one strategy per server platform,
// serving the REAL OS icons for the two system targets (Finder / Terminal):
// darwin reads the bundle's .icns via plutil + converts with sips; win32 runs
// a generated PowerShell script (System.Drawing ExtractAssociatedIcon);
// linux follows XDG desktop entries into the hicolor theme. Every failure
// resolves null — the /icons route answers 404 and the client falls back to
// its generic glyph (the documented contract, not a degraded state).
//
// All host interaction is injected: `run` (argv commands), a read-only
// in-memory fs, and a temp scratchpad — no real subprocess or disk here.

import { describe, it, expect } from 'vitest'
import { extractTargetIcon, type IconDeps } from './open-path-icons.js'

/** In-memory fs fixture: paths → bytes (text files stored as utf8). */
function fixtureFs(files: Record<string, string | Buffer>): Pick<
  IconDeps,
  'readBytes' | 'fileExists' | 'listDir'
> {
  return {
    readBytes: async (p) => {
      const v = files[p]
      if (v === undefined) throw new Error(`ENOENT: ${p}`)
      return typeof v === 'string' ? Buffer.from(v, 'utf8') : v
    },
    fileExists: async (p) => files[p] !== undefined,
    listDir: async (p) =>
      Object.keys(files)
        .filter((k) => k.startsWith(p.endsWith('/') ? p : p + '/'))
        .map((k) => k.slice(p.length + 1)),
  }
}

/** In-memory temp scratchpad. `written` records what subprocesses "produced"
 *  — a test pre-seeds the output path to simulate a successful converter. */
function fixtureTemp(output: Record<string, Buffer> = {}): {
  temp: IconDeps['temp']
  scriptBodies: string[]
} {
  const scripts: string[] = []
  return {
    scriptBodies: scripts,
    temp: {
      dir: async () => '/tmp/icon-tmp',
      writeFile: async (_dir, name, content) => {
        scripts.push(content)
        return `/tmp/icon-tmp/${name}`
      },
      readFile: async (p) => {
        const v = output[p]
        if (v === undefined) throw new Error(`ENOENT: ${p}`)
        return v
      },
      remove: async () => {},
    },
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const FinderPlist = JSON.stringify({ CFBundleIconFile: 'finder' })

describe('extractTargetIcon — darwin', () => {
  const bundle = '/System/Library/CoreServices/Finder.app'
  const files = {
    [`${bundle}/Contents/Info.plist`]: FinderPlist,
    [`${bundle}/Contents/Resources/finder.icns`]: 'ICNS',
  }

  it('converts the CFBundleIconFile icns to a 128px png via sips', async () => {
    const { temp, scriptBodies } = fixtureTemp({ '/tmp/icon-tmp/icon.png': PNG })
    let sipsArgs: string[] = []
    const deps: IconDeps = {
      ...fixtureFs(files),
      temp,
      env: {},
      home: '/home/u',
      run: async (file, args) => {
        if (file === 'plutil') return { stdout: FinderPlist }
        sipsArgs = [...args]
        return { stdout: '' }
      },
    }
    const icon = await extractTargetIcon('finder', 'darwin', deps)
    expect(icon).not.toBeNull()
    expect(icon!.contentType).toBe('image/png')
    expect(icon!.bytes.equals(PNG)).toBe(true)
    expect(sipsArgs).toContain('-Z')
    expect(sipsArgs).toContain(`${bundle}/Contents/Resources/finder.icns`)
    expect(sipsArgs).toContain('/tmp/icon-tmp/icon.png')
    expect(scriptBodies).toEqual([]) // darwin writes no scripts
  })

  it('falls back to the first Resources .icns when Info.plist carries no icon', async () => {
    const noIconFiles = {
      [`${bundle}/Contents/Info.plist`]: JSON.stringify({ CFBundleIdentifier: 'x' }),
      [`${bundle}/Contents/Resources/other.icns`]: 'ICNS',
    }
    const { temp } = fixtureTemp({ '/tmp/icon-tmp/icon.png': PNG })
    const deps: IconDeps = {
      ...fixtureFs(noIconFiles),
      temp,
      env: {},
      home: '/home/u',
      run: async (file) => {
        if (file === 'plutil') return { stdout: noIconFiles[`${bundle}/Contents/Info.plist`] as string }
        return { stdout: '' } // sips "succeeds"
      },
    }
    const icon = await extractTargetIcon('finder', 'darwin', deps)
    expect(icon?.contentType).toBe('image/png')
  })

  it('resolves null when the bundle is absent (non-mac reality, not a fallback state)', async () => {
    const deps: IconDeps = { ...fixtureFs({}), ...fixtureTemp(), env: {}, home: '/home/u', run: async () => ({ stdout: '' }) }
    expect(await extractTargetIcon('finder', 'darwin', deps)).toBeNull()
  })
})

describe('extractTargetIcon — win32', () => {
  it('runs the generated PowerShell script against the expanded exe and returns the png', async () => {
    const { temp, scriptBodies } = fixtureTemp({ '/tmp/icon-tmp/icon.png': PNG })
    let psArgs: readonly string[] = []
    const deps: IconDeps = {
      ...fixtureFs({ 'C:/Windows/explorer.exe': 'MZ' }),
      temp,
      env: { SystemRoot: 'C:/Windows' },
      home: 'C:/Users/u',
      run: async (file, args) => {
        expect(file).toBe('powershell.exe')
        psArgs = args
        return { stdout: '' }
      },
    }
    const icon = await extractTargetIcon('finder', 'win32', deps)
    expect(icon?.contentType).toBe('image/png')
    expect(psArgs).toContain('-File')
    expect(psArgs).toContain('C:/Windows/explorer.exe')
    expect(psArgs).toContain('/tmp/icon-tmp/icon.png')
    expect(scriptBodies[0]).toContain('ExtractAssociatedIcon')
  })

  it('resolves null when the exe path does not exist', async () => {
    const deps: IconDeps = {
      ...fixtureFs({}),
      ...fixtureTemp(),
      env: { SystemRoot: 'C:/Windows' },
      home: 'C:/Users/u',
      run: async () => ({ stdout: '' }),
    }
    expect(await extractTargetIcon('finder', 'win32', deps)).toBeNull()
  })
})

describe('extractTargetIcon — linux', () => {
  const entry = [
    '[Desktop Entry]',
    'Name=Terminal',
    'Exec=gnome-terminal',
    'Icon=org.gnome.Terminal',
    '',
  ].join('\n')

  it('follows the desktop entry Icon= into the hicolor theme (png)', async () => {
    const { temp } = fixtureTemp()
    const files = {
      '/usr/share/applications/org.gnome.Terminal.desktop': entry,
      '/usr/share/icons/hicolor/48x48/apps/org.gnome.Terminal.png': PNG,
    }
    const icon = await extractTargetIcon('terminal', 'linux', { ...fixtureFs(files), temp, env: {}, home: '/home/u', run: async () => ({ stdout: '' }) })
    expect(icon?.contentType).toBe('image/png')
    expect(icon!.bytes.equals(PNG)).toBe(true)
  })

  it('serves scalable svg entries with the svg content type', async () => {
    const { temp } = fixtureTemp()
    const files = {
      '/usr/share/applications/org.gnome.Terminal.desktop': entry,
      '/usr/share/icons/hicolor/scalable/apps/org.gnome.Terminal.svg': '<svg/>',
    }
    const icon = await extractTargetIcon('terminal', 'linux', { ...fixtureFs(files), temp, env: {}, home: '/home/u', run: async () => ({ stdout: '' }) })
    expect(icon?.contentType).toBe('image/svg+xml')
  })

  it('tries the DE terminal chain (gnome, then kde) before giving up', async () => {
    const { temp } = fixtureTemp()
    const files = {
      '/usr/share/applications/org.kde.konsole.desktop': '[Desktop Entry]\nIcon=konsole\n',
      '/usr/share/pixmaps/konsole.png': PNG,
    }
    const icon = await extractTargetIcon('terminal', 'linux', { ...fixtureFs(files), temp, env: {}, home: '/home/u', run: async () => ({ stdout: '' }) })
    expect(icon?.contentType).toBe('image/png')
  })

  it('resolves null for finder on linux (DSH parity: no file-manager entry to follow)', async () => {
    const { temp } = fixtureTemp()
    const icon = await extractTargetIcon('finder', 'linux', { ...fixtureFs({}), temp, env: {}, home: '/home/u', run: async () => ({ stdout: '' }) })
    expect(icon).toBeNull()
  })
})

describe('extractTargetIcon — platform gate', () => {
  it('resolves null off the three supported platforms', async () => {
    const deps: IconDeps = { ...fixtureFs({}), ...fixtureTemp(), env: {}, home: '/u', run: async () => ({ stdout: '' }) }
    expect(await extractTargetIcon('finder', 'sunos', deps)).toBeNull()
  })
})
