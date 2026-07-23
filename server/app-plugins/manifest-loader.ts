// Server-side manifest loading: read `crw-plugin.json` from a plugin
// directory, realpath-resolve the directory (so symlink escape is caught
// upstream of the pure path checks), validate it, and hash it.
//
// The pure structural validation lives in shared/app-plugins/manifest-
// validator.ts (shared with the browser for install-preview diagnostics);
// this module is the thin filesystem wrapper that feeds it real paths.

import { promises as fs } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { createHash } from 'node:crypto'
import { createLogger } from '../log.js'
import { MANIFEST_FILE } from '../../shared/app-plugins/manifest.js'
import { validateManifest, type ManifestValidationResult } from '../../shared/app-plugins/manifest-validator.js'
import { LIMITS } from '../../shared/app-plugins/validation.js'
import type { PluginManifest } from '../../shared/app-plugins/manifest.js'

const log = createLogger('app-plugins')

export interface LoadedManifest {
  manifest: PluginManifest
  hash: string
  validation: ManifestValidationResult
}

export interface LoadManifestOptions {
  hostVersion: string
  hostNodeMajor: number
  isWindows?: boolean
}

/** Read + validate a plugin manifest from `dir`. Throws on I/O error or
 *  oversize file; returns a `LoadedManifest` whose `validation.ok` flag is
 *  the authoritative gate (the manager refuses to register when false). */
export async function loadManifest(dir: string, opts: LoadManifestOptions): Promise<LoadedManifest> {
  const isWindows = opts.isWindows ?? process.platform === 'win32'
  const manifestPath = resolvePath(dir, MANIFEST_FILE)

  // Stat before readFile so an oversized (or deliberately huge) manifest is
  // rejected without slurping it into memory first.
  let stat
  try {
    stat = await fs.stat(manifestPath)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') throw new Error(`no ${MANIFEST_FILE} found in ${dir}`)
    throw new Error(`failed to stat ${MANIFEST_FILE}: ${e.message}`)
  }
  if (!stat.isFile()) throw new Error(`${MANIFEST_FILE} is not a regular file`)
  if (stat.size > LIMITS.manifestBytes) {
    throw new Error(`${MANIFEST_FILE} exceeds ${LIMITS.manifestBytes} bytes`)
  }

  let raw: string
  try {
    raw = await fs.readFile(manifestPath, 'utf8')
  } catch (err) {
    throw new Error(`failed to read ${MANIFEST_FILE}: ${(err as Error).message}`)
  }

  if (Buffer.byteLength(raw, 'utf8') > LIMITS.manifestBytes) {
    throw new Error(`${MANIFEST_FILE} exceeds ${LIMITS.manifestBytes} bytes`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${MANIFEST_FILE} is not valid JSON: ${(err as Error).message}`)
  }

  const validation = validateManifest(parsed, {
    hostVersion: opts.hostVersion,
    hostNodeMajor: opts.hostNodeMajor,
    isWindows,
  })
  const hash = createHash('sha256').update(raw).digest('hex')
  if (!validation.ok) {
    log.warn(`manifest validation failed: ${validation.errors.join('; ')}`)
    return { manifest: parsed as PluginManifest, hash, validation }
  }
  return { manifest: parsed as PluginManifest, hash, validation }
}

/** Realpath-resolve a plugin directory, rejecting if it doesn't exist or
 *  isn't a directory. Used by the installer before loadManifest so the
 *  stored `source.path` is canonical (symlinks resolved, no `..`). */
export async function resolvePluginDir(inputPath: string): Promise<string> {
  let resolved: string
  try {
    resolved = await fs.realpath(resolvePath(inputPath))
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') throw new Error(`plugin directory not found: ${inputPath}`)
    throw new Error(`failed to resolve plugin directory ${inputPath}: ${e.message}`)
  }
  const stat = await fs.stat(resolved)
  if (!stat.isDirectory()) throw new Error(`plugin path is not a directory: ${inputPath}`)
  return resolved
}
