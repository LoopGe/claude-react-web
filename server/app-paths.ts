// Windows App Paths registry reader — the locator that proves where an
// installed executable lives regardless of install directory. Installers
// (VS Code's and Kiro's Inno Setup among them) register
// `HK*\Software\Microsoft\Windows\CurrentVersion\App Paths\<exe>` with the
// full executable path as the default value; ShellExecute / Win+R resolve
// through the same key. A custom-directory install that neither default
// install path covers is therefore still discoverable here.
//
// The boundary is PowerShell, NOT reg.exe: a console child emits its console
// output code page (the OEM page — gb2312 on zh-CN), so reg.exe's text would
// mojibake any non-ASCII install path under utf8 decoding. The fixed script
// forces UTF-8 stdout and prints each root's RAW default value as one line
// (HKCU first, empty when the key or value is absent); DoNotExpandEnvironmentNames
// keeps `%VAR%` for the TS-side expander. Fixed argv, never a shell string;
// any query failure has one meaning: no root proves anything. The resolved
// value is quote-stripped, %VAR%-expanded, and verified on disk before it
// counts as a launcher.

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { expandEnvReferences } from './env-expand.js'

/** Per-query deadline — PowerShell cold start is hundreds of milliseconds;
 *  the timeout only binds on a wedged system. */
const QUERY_TIMEOUT_MS = 10_000

/** App Paths roots in the script's line order, user hive first (per-user
 *  installs shadow machine ones). The reader indexes stdout lines by this
 *  order — the two must stay aligned. */
const APP_PATHS_ROOTS = [
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
] as const

/** The fixed query script for one registered exe name (a catalog constant,
 *  never user input): force UTF-8 stdout, then one raw default-value line
 *  per root. */
function queryScript(exeName: string): string {
  const roots = APP_PATHS_ROOTS.map((root) => `'${root}'`).join(',')
  return (
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
    `foreach ($root in @(${roots})) { ` +
    `$key = Get-Item -LiteralPath "$root\\${exeName}" -ErrorAction SilentlyContinue; ` +
    "if ($null -eq $key) { Write-Output '' } else " +
    "{ Write-Output ([string]$key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)) } }"
  )
}

/** Injectable process facts for deterministic tests. `run` is the bounded
 *  query boundary: stdout on success, null on ANY failure. */
export interface AppPathsDeps {
  readonly run: (file: string, args: readonly string[]) => Promise<string | null>
  readonly fileExists: (path: string) => Promise<boolean>
  readonly env: NodeJS.ProcessEnv
}

/**
 * Resolve one registered executable name to its verified on-disk path:
 * the script's per-root lines in order (HKCU then HKLM), first value that
 * expands to an existing file wins. Null when no root proves a launcher.
 */
export async function readAppPathsTarget(exeName: string, deps: AppPathsDeps): Promise<string | null> {
  const stdout = await deps.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', queryScript(exeName)])
  if (stdout === null) return null
  // One line per root in root order; a missing or empty line means that root
  // proves nothing (an empty answer proves nothing at all).
  const lines = stdout.split(/\r?\n/).slice(0, APP_PATHS_ROOTS.length)
  for (const line of lines) {
    const raw = line.trim()
    if (raw === '') continue
    const expanded = expandEnvReferences(raw.replace(/^"|"$/g, ''), deps.env, /%([^%]+)%/g)
    if (expanded !== null && (await deps.fileExists(expanded))) return expanded
  }
  return null
}

/** The real query boundary: fixed argv, timeout, hidden window (the repo's
 *  uniform execFile discipline — a console child must not flash a window on
 *  console-less hosts), failure → null. Uses the raw execFile callback
 *  contract (err, stdout) rather than promisify — the promisified shape
 *  depends on execFile's custom promisify symbol, which a plain test mock
 *  does not carry. stdout is utf8-decoded correctly because the script
 *  forces UTF-8 output. */
export const hostAppPathsRun: AppPathsDeps['run'] = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: QUERY_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })

/** The real disk-existence fact the reader verifies resolved values with. */
export async function hostAppPathsFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}