// Open-path icon extraction: the REAL OS icons for the two system targets
// (Finder / Terminal), one strategy per server platform — the same techniques
// DSH validated, sized to our closed target set:
//   • darwin: bundle .icns via `plutil` (Info.plist JSON) + `sips` → 128px PNG
//   • win32: generated PowerShell script, System.Drawing
//     ExtractAssociatedIcon → PNG (largest size without a native addon)
//   • linux: XDG desktop entry `Icon=` → hicolor theme → pixmaps (PNG/SVG,
//     zero subprocesses)
// A linux `finder` resolves null by design (DSH parity: there is no single
// file-manager entry to follow). EVERY failure resolves null — the route
// answers 404 and the client renders its generic glyph. That is the
// protocol's defined answer for "this icon genuinely does not exist here",
// not a degraded state.
//
// Spawn discipline mirrors the rest of the server: execFile-shaped argv runs
// (never a shell), per-command timeouts, temp files cleaned up in finally.

import { join } from 'node:path'
import { mkdtemp, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { OpenPathGlyphTarget } from '../shared/open-path.js'

export type { OpenPathGlyphTarget }

const execFileAsync = promisify(execFile)

const RUN_TIMEOUT_MS = 10_000
const PS_TIMEOUT_MS = 15_000

export interface ExtractedIcon {
  bytes: Buffer
  contentType: 'image/png' | 'image/svg+xml'
}

export interface IconDeps {
  /** Bounded argv command runner — the execFile shape, never a shell. */
  run: (file: string, args: readonly string[], timeoutMs: number) => Promise<{ stdout: string }>
  readBytes: (path: string) => Promise<Buffer>
  fileExists: (path: string) => Promise<boolean>
  listDir: (path: string) => Promise<string[]>
  /** Temp scratchpad for converter outputs and generated scripts. */
  temp: {
    dir: () => Promise<string>
    writeFile: (dir: string, name: string, content: string) => Promise<string>
    readFile: (path: string) => Promise<Buffer>
    remove: (path: string) => Promise<void>
  }
  env: NodeJS.ProcessEnv
  home: string
}

/** The real host wiring: execFile with fixed argv, real fs. */
export const hostIconDeps: IconDeps = {
  run: (file, args, timeoutMs) => execFileAsync(file, [...args], { timeout: timeoutMs, windowsHide: true }),
  readBytes: (p) => readFile(p),
  fileExists: async (p) => {
    try {
      return (await stat(p)).isFile()
    } catch {
      return false
    }
  },
  listDir: (p) => readdir(p),
  temp: {
    dir: () => mkdtemp(join(tmpdir(), 'crw-icon-')),
    writeFile: async (dir, name, content) => {
      const path = join(dir, name)
      await writeFile(path, content, 'utf8')
      return path
    },
    readFile: (p) => readFile(p),
    remove: (p) => rm(p, { recursive: true, force: true }),
  },
  env: process.env,
  home: '',
}

/** System bundle per target — ships with the OS, path trusted like DSH's
 *  `fixed` locators (a somehow-missing file surfaces as null at probe time). */
const DARWIN_BUNDLES: Record<OpenPathGlyphTarget, string> = {
  finder: '/System/Library/CoreServices/Finder.app',
  terminal: '/System/Applications/Utilities/Terminal.app',
}

/** First `.icns` in the bundle Resources — the fallback when Info.plist
 *  declares no `CFBundleIconFile` (or one that is not on disk). */
async function darwinIcnsName(bundle: string, deps: IconDeps): Promise<string | null> {
  const resources = join(bundle, 'Contents', 'Resources')
  const declared = await deps
    .run('plutil', ['-convert', 'json', '-o', '-', join(bundle, 'Contents', 'Info.plist')], RUN_TIMEOUT_MS)
    .then((r) => {
      try {
        const value = (JSON.parse(r.stdout) as { CFBundleIconFile?: unknown }).CFBundleIconFile
        return typeof value === 'string' && value !== '' ? (value.endsWith('.icns') ? value : `${value}.icns`) : null
      } catch {
        return null
      }
    })
    .catch(() => null)
  if (declared !== null && (await deps.fileExists(join(resources, declared)))) return declared
  try {
    return (await deps.listDir(resources)).find((entry) => entry.endsWith('.icns')) ?? null
  } catch {
    return null
  }
}

async function extractDarwin(target: OpenPathGlyphTarget, deps: IconDeps): Promise<ExtractedIcon | null> {
  const bundle = DARWIN_BUNDLES[target]
  if (!(await deps.fileExists(join(bundle, 'Contents', 'Info.plist')))) return null
  const icnsName = await darwinIcnsName(bundle, deps)
  if (icnsName === null) return null
  const icnsPath = join(bundle, 'Contents', 'Resources', icnsName)
  const dir = await deps.temp.dir()
  try {
    const out = join(dir, 'icon.png')
    await deps.run('sips', ['-s', 'format', 'png', '-Z', '128', icnsPath, '--out', out], RUN_TIMEOUT_MS)
    return { bytes: await deps.temp.readFile(out), contentType: 'image/png' }
  } finally {
    await deps.temp.remove(dir)
  }
}

/** PowerShell runner for win32 — System.Drawing's ExtractAssociatedIcon is
 *  the largest icon size reachable without a native addon (DSH's finding). */
const PS_SCRIPT = [
  'Add-Type -AssemblyName System.Drawing',
  '$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($args[0])',
  '$icon.ToBitmap().Save($args[1], [System.Drawing.Imaging.ImageFormat]::Png)',
  '',
].join('\r\n')

function expandTemplate(template: string, env: NodeJS.ProcessEnv): string | null {
  let unset = false
  const expanded = template.replace(/\$\{([^}]+)\}/g, (_m, name: string) => {
    if (env[name] === undefined) unset = true
    return env[name] ?? ''
  })
  return unset ? null : expanded
}

const WIN32_EXES: Record<OpenPathGlyphTarget, string> = {
  finder: '${SystemRoot}/explorer.exe',
  terminal: '${LOCALAPPDATA}/Microsoft/WindowsApps/wt.exe',
}

async function extractWin32(target: OpenPathGlyphTarget, deps: IconDeps): Promise<ExtractedIcon | null> {
  const exe = expandTemplate(WIN32_EXES[target], deps.env)
  if (exe === null || !(await deps.fileExists(exe))) return null
  const dir = await deps.temp.dir()
  try {
    const script = await deps.temp.writeFile(dir, 'extract-icon.ps1', PS_SCRIPT)
    const out = join(dir, 'icon.png')
    await deps.run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, exe, out],
      PS_TIMEOUT_MS,
    )
    return { bytes: await deps.temp.readFile(out), contentType: 'image/png' }
  } finally {
    await deps.temp.remove(dir)
  }
}

/** Terminal desktop-entry ids in DE launch-candidate order (mirrors the
 *  generic terminal's gnome → konsole candidates). Finder has no counterpart
 *  — there is no single file-manager entry on linux, so it resolves null
 *  (DSH ships the same absence). */
const LINUX_DESKTOP_IDS: Record<OpenPathGlyphTarget, readonly string[]> = {
  finder: [],
  terminal: ['org.gnome.Terminal', 'org.kde.konsole'],
}

const HICOLOR_SIZES = ['scalable', '128x128', '64x64', '48x48'] as const
const ICON_EXTS = ['png', 'svg'] as const

function contentTypeOf(path: string): ExtractedIcon['contentType'] | null {
  return path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.png') ? 'image/png' : null
}

function parseDesktopIcon(text: string): string | null {
  const line = text.split(/\r?\n/).find((l) => l.startsWith('Icon='))
  return line === undefined ? null : line.slice('Icon='.length).trim() || null
}

async function extractLinux(target: OpenPathGlyphTarget, deps: IconDeps): Promise<ExtractedIcon | null> {
  const dataDirs = [
    deps.env.XDG_DATA_HOME ?? join(deps.home, '.local/share'),
    ...(deps.env.XDG_DATA_DIRS ?? '/usr/local/share:/usr/share').split(':'),
  ].filter((d) => d !== '')
  for (const id of LINUX_DESKTOP_IDS[target]) {
    for (const dataDir of dataDirs) {
      const entryPath = join(dataDir, 'applications', `${id}.desktop`)
      if (!(await deps.fileExists(entryPath))) continue
      let iconName: string | null = null
      try {
        iconName = parseDesktopIcon((await deps.readBytes(entryPath)).toString('utf8'))
      } catch {
        continue
      }
      if (iconName === null) continue
      // Absolute Icon= paths are used as-is; theme names walk hicolor then
      // pixmaps, first existing png/svg wins.
      if ((await deps.fileExists(iconName)) && iconName.includes('.')) {
        const type = contentTypeOf(iconName)
        if (type !== null) {
          try {
            return { bytes: await deps.readBytes(iconName), contentType: type }
          } catch {
            continue
          }
        }
      }
      const candidates: string[] = []
      for (const size of HICOLOR_SIZES) {
        for (const ext of ICON_EXTS) candidates.push(join(dataDir, 'icons/hicolor', size, 'apps', `${iconName}.${ext}`))
      }
      for (const ext of ICON_EXTS) candidates.push(join(dataDir, 'pixmaps', `${iconName}.${ext}`))
      for (const candidate of candidates) {
        if (!(await deps.fileExists(candidate))) continue
        const type = contentTypeOf(candidate)
        if (type === null) continue
        try {
          return { bytes: await deps.readBytes(candidate), contentType: type }
        } catch {
          continue
        }
      }
    }
  }
  return null
}

const EXTRACTORS: Record<string, ((target: OpenPathGlyphTarget, deps: IconDeps) => Promise<ExtractedIcon | null>) | undefined> = {
  darwin: extractDarwin,
  win32: extractWin32,
  linux: extractLinux,
}

/**
 * Extract the OS icon for one system target on the running platform, or
 * null when it does not exist here (unsupported platform, absent bundle/exe,
 * failed conversion). Never throws.
 */
export async function extractTargetIcon(
  target: OpenPathGlyphTarget,
  platformName: string,
  deps: IconDeps,
): Promise<ExtractedIcon | null> {
  const extractor = EXTRACTORS[platformName]
  if (extractor === undefined) return null
  try {
    return await extractor(target, deps)
  } catch {
    return null
  }
}
