// Resolve the text encoding for decoding shell-subprocess output.
//
// Why this exists: on Chinese (and other non-English) Windows, `cmd.exe`
// emits its localised messages — e.g. `'cwd' 不是内部或外部命令…` — in the
// system OEM codepage (CP936/GBK). exec.ts used to decode captured bytes
// unconditionally as UTF-8, which turned those GBK bytes into mojibake.
// We instead detect the codepage cmd will actually use and decode with a
// matching WHATWG label via the global TextDecoder (Node ships full ICU,
// so gbk/big5/shift_jis/etc. are supported with no extra deps).
//
// Cross-platform: Windows → OEM codepage detection; everywhere else →
// UTF-8, the de-facto standard for modern Unix tooling.

import { execFileSync } from 'node:child_process'
import { createLogger } from './log.js'

const log = createLogger('shell-encoding')

/** Windows OEM codepage number → WHATWG TextDecoder label. Only the
 *  codepages that actually carry localised (non-ASCII) text need mapping;
 *  anything unmapped falls back to UTF-8. */
const CP_TO_LABEL: Readonly<Record<string, string>> = {
  '936': 'gbk',
  '950': 'big5',
  '932': 'shift_jis',
  '949': 'euc-kr',
  '866': 'cp866',
  '437': 'cp437',
  '850': 'cp850',
  '1250': 'windows-1250',
  '1251': 'windows-1251',
  '1252': 'windows-1252',
  '1253': 'windows-1253',
  '1254': 'windows-1254',
  '1255': 'windows-1255',
  '1256': 'windows-1256',
  '1257': 'windows-1257',
  '1258': 'windows-1258',
  '65001': 'utf-8',
}

/** Pure mapping, exported for unit testing. Returns the UTF-8 label for
 *  unknown codepages (fail-open to the prior behaviour rather than
 *  mis-decoding). */
export function codepageToLabel(cp: string): string {
  return CP_TO_LABEL[cp] ?? 'utf-8'
}

/** Extract the first 3–5 digit run from `chcp.com` output. `chcp`
 *  localises its label text ("Active code page" vs "活动代码页") but the
 *  codepage number is always a bare digit run, so a locale-agnostic
 *  digit match is the robust extraction. */
function extractCodepage(s: string): string | undefined {
  const m = s.match(/(\d{3,5})/)
  return m ? m[1] : undefined
}

/** Detect the active Windows console codepage. Tries `chcp.com` first
 *  (most accurate when a console is attached), then falls back to the
 *  system OEM codepage in the registry (locale-independent ASCII, works
 *  headless). Any failure → UTF-8. */
function detectWindows(): string {
  try {
    const out = execFileSync('chcp.com', [], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 3_000,
    })
    const cp = extractCodepage(out)
    if (cp) return codepageToLabel(cp)
  } catch (err) {
    log.debug(`chcp detection failed: ${err}`)
  }
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'],
      { windowsHide: true, encoding: 'utf8', timeout: 3_000 },
    )
    const m = out.match(/OEMCP\s+REG_SZ\s+(\d+)/)
    if (m) return codepageToLabel(m[1])
  } catch (err) {
    log.debug(`registry OEMCP detection failed: ${err}`)
  }
  return 'utf-8'
}

let cached: string | undefined

/** Resolve the text encoding to use when decoding shell subprocess output.
 *  Result is cached for the process lifetime — the codepage does not change
 *  while the server runs. */
export function resolveShellEncoding(): string {
  if (cached) return cached
  cached = process.platform === 'win32' ? detectWindows() : 'utf-8'
  log.debug(`shell output encoding: ${cached}`)
  return cached
}
