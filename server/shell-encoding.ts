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

/** Decode one captured output stream (stdout or stderr) to a string.
 *
 *  Strategy: strict UTF-8 first, shell codepage second. Modern tools (Node,
 *  npm, npx, git, most CLIs) write UTF-8 to a pipe regardless of console
 *  codepage, so they decode cleanly at step 1. Legacy emitters — cmd.exe's
 *  own localised messages, Python under a non-UTF-8 locale — write OEM
 *  bytes (e.g. CP936/GBK) which are NOT valid UTF-8 and fall through to the
 *  codepage decoder.
 *
 *  Unconditional codepage decoding (the previous behaviour) mojibakes the
 *  UTF-8 majority; unconditional UTF-8 mojibakes the legacy case. The
 *  strict-try splits them without a detector library. Mixed-encoding
 *  streams within one capture fall back to the codepage — same as the old
 *  behaviour, never worse.
 *
 *  Known limitation: a run of GBK bytes can, by chance, form valid UTF-8
 *  (e.g. 系统 → CF B5 CD B3, also UTF-8 for "ϵͳ"). Those decode as UTF-8
 *  instead of falling back. Probed on this host: full cmd.exe error strings
 *  are safe (long enough that some pair breaks UTF-8 validity), but several
 *  short 2-char words are not (系统/模式/目录/状态/杀 — 5 of 35 common
 *  words). Closing this needs a chardetng-style detector (plan B) or
 *  forcing UTF-8 at the shell boundary — out of scope here.
 *
 *  `fallbackLabel` is a WHATWG TextDecoder label and defaults to the
 *  detected shell encoding; tests pass it explicitly to stay
 *  platform-independent. */
/** True when the last `strip` bytes of `bytes` are a real incomplete UTF-8
 *  sequence: a lead byte whose total sequence length exceeds `strip`, with
 *  only continuation bytes after it. */
function isTruncatedUtf8Tail(bytes: Uint8Array, strip: number): boolean {
  const start = bytes.length - strip
  const lead = bytes[start]
  // UTF-8 lead-byte ranges: 110xxxxx (2-byte) … 11110xxx (4-byte).
  // 0xC0/0xC1 are the UTF-8 overlong leads — never appear in real output.
  let seqLen: number
  if (lead >= 0xc2 && lead <= 0xdf) seqLen = 2
  else if (lead >= 0xe0 && lead <= 0xef) seqLen = 3
  else if (lead >= 0xf0 && lead <= 0xf4) seqLen = 4
  else return false
  if (seqLen <= strip) return false // the sequence would have been complete
  for (let i = start + 1; i < bytes.length; i++) {
    if ((bytes[i] & 0xc0) !== 0x80) return false // not a continuation byte
  }
  return true
}

/** Decode one captured output stream (stdout or stderr) to a string.
 *
 *  Strategy: strict UTF-8 first, shell codepage second. Modern tools (Node,
 *  npm, npx, git, most CLIs) write UTF-8 to a pipe regardless of console
 *  codepage, so they decode cleanly at step 1. Legacy emitters — cmd.exe's
 *  own localised messages, Python under a non-UTF-8 locale — write OEM
 *  bytes (e.g. CP936/GBK) which are NOT valid UTF-8 and fall through to the
 *  codepage decoder.
 *
 *  Unconditional codepage decoding (the previous behaviour) mojibakes the
 *  UTF-8 majority; unconditional UTF-8 mojibakes the legacy case. The
 *  strict-try splits them without a detector library. Mixed-encoding
 *  streams within one capture fall back to the codepage — same as the old
 *  behaviour, never worse.
 *
 *  Truncated tail (SIGKILL mid-sequence): the incomplete 1–3 byte tail is
 *  dropped and replaced with U+FFFD so it cannot drag the rest of an
 *  otherwise-valid UTF-8 stream into the codepage fallback. The rescue only
 *  fires on positive UTF-8 evidence — the prefix must decode as UTF-8 and
 *  contain a multi-byte character — because 1024 GBK hanzi (lead E0–EF ×
 *  trail 80–BF) are byte-identical to a truncated 3-byte UTF-8 sequence,
 *  and an ASCII prefix cannot tell the two apart. Empty prefix (the whole
 *  capture IS the incomplete sequence) is rescued unconditionally.
 *
 *  Known limitation: a run of GBK bytes can, by chance, form valid UTF-8
 *  (e.g. 系统 → CF B5 CD B3, also UTF-8 for "ϵͳ"). Those decode as UTF-8
 *  instead of falling back. Probed on this host: full cmd.exe error strings
 *  are safe (long enough that some pair breaks UTF-8 validity), but several
 *  short 2-char words are not (系统/模式/目录/状态/杀 — 5 of 35 common
 *  words). Closing this needs a chardetng-style detector (plan B) or
 *  forcing UTF-8 at the shell boundary — out of scope here.
 *
 *  `fallbackLabel` is a WHATWG TextDecoder label and defaults to the
 *  detected shell encoding; tests pass it explicitly to stay
 *  platform-independent. */
export function decodeShellBytes(bytes: Uint8Array, fallbackLabel?: string): string {
  if (bytes.length === 0) return ''
  const utf8 = () => new TextDecoder('utf-8', { fatal: true })
  try {
    return utf8().decode(bytes)
  } catch {
    // strip === bytes.length is allowed: the whole capture can be just the
    // incomplete sequence, and its correct rendering is U+FFFD.
    for (let strip = 1; strip <= 3 && strip <= bytes.length; strip++) {
      if (!isTruncatedUtf8Tail(bytes, strip)) continue
      const prefix = bytes.subarray(0, bytes.length - strip)
      // Positive UTF-8 evidence before rescuing: a multi-byte character in
      // the prefix, or no prefix at all. An ASCII-only prefix is ambiguous
      // — the tail may be a complete GBK hanzi that merely mimics a
      // truncated sequence — so we leave it to the codepage decoder.
      const hasUtf8Evidence = prefix.length === 0 || prefix.some((b) => b >= 0x80)
      if (!hasUtf8Evidence) continue
      try {
        return utf8().decode(prefix) + '�'
      } catch {
        /* prefix still invalid — try a longer strip / fall through */
      }
    }
    return new TextDecoder(fallbackLabel ?? resolveShellEncoding()).decode(bytes)
  }
}
