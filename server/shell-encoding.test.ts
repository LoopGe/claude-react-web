import { describe, it, expect } from 'vitest'
import { codepageToLabel, decodeShellBytes } from './shell-encoding.js'

describe('codepageToLabel', () => {
  it('maps the common CJK OEM codepages to their WHATWG labels', () => {
    expect(codepageToLabel('936')).toBe('gbk')
    expect(codepageToLabel('950')).toBe('big5')
    expect(codepageToLabel('932')).toBe('shift_jis')
    expect(codepageToLabel('949')).toBe('euc-kr')
  })

  it('maps Windows-125x ANSI codepages', () => {
    expect(codepageToLabel('1252')).toBe('windows-1252')
    expect(codepageToLabel('1251')).toBe('windows-1251')
  })

  it('treats UTF-8 codepage as utf-8', () => {
    expect(codepageToLabel('65001')).toBe('utf-8')
  })

  it('falls back to utf-8 for unknown codepages (fail-open)', () => {
    expect(codepageToLabel('99999')).toBe('utf-8')
    expect(codepageToLabel('')).toBe('utf-8')
  })
})

describe('decodeShellBytes', () => {
  // Regression: `npx skills` (a Node tool) emits UTF-8 symbols — ✗ U+2717,
  // → U+2192, │ U+2502 — which must survive decoding even on a CP936 host
  // where the fallback label is gbk. Decoding those bytes as GBK yields
  // 鉁鉁�/鈫�/鈹� mojibake (the original bug).
  it('decodes UTF-8 bytes as UTF-8 even when the fallback label is gbk', () => {
    const utf8 = Buffer.from('✗ deploy-to-vercel → PromptScript: │ 中文', 'utf8')
    expect(decodeShellBytes(utf8, 'gbk')).toBe('✗ deploy-to-vercel → PromptScript: │ 中文')
  })

  it('preserves UTF-8 box-drawing and spinner glyphs', () => {
    const utf8 = Buffer.from('└─╯ ● ◐ ✓', 'utf8')
    expect(decodeShellBytes(utf8, 'gbk')).toBe('└─╯ ● ◐ ✓')
  })

  // The case shell-encoding.ts was written for: cmd.exe localised messages
  // are OEM-codepage bytes, NOT valid UTF-8. Those must fall back and decode
  // correctly under the shell's own codepage.
  it('falls back to the shell codepage when bytes are not valid UTF-8', () => {
    // GBK for 你好世界 — verified bytes, not derived from the function under test
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7])
    expect(decodeShellBytes(gbk, 'gbk')).toBe('你好世界')
  })

  it('decodes a cmd.exe-style GBK error message via the fallback', () => {
    // GBK for the prefix of "'cwd' 不是内部或外部命令" (captured from a real
    // chcp-936 cmd.exe, see the investigation notes)
    const gbk = Buffer.from([0x27, 0x63, 0x77, 0x64, 0x27, 0x20, 0xb2, 0xbb, 0xca, 0xc7, 0xc4, 0xda, 0xb2, 0xbf])
    expect(decodeShellBytes(gbk, 'gbk')).toBe("'cwd' 不是内部")
  })

  it('returns an empty string for empty input', () => {
    expect(decodeShellBytes(new Uint8Array(0), 'gbk')).toBe('')
    expect(decodeShellBytes(Buffer.alloc(0))).toBe('')
  })

  it('leaves pure ASCII unchanged (valid under both encodings)', () => {
    expect(decodeShellBytes(Buffer.from('npm warn exec: skills@1.7.4\n', 'utf8'), 'gbk')).toBe(
      'npm warn exec: skills@1.7.4\n',
    )
  })

  // A SIGKILL / Stop press can cut the child's last write mid-character. The
  // truncated tail must not re-encode the whole (otherwise valid UTF-8) stream
  // as the fallback codepage — that would mojibake the majority, the very
  // thing this function exists to protect.
  it('keeps a UTF-8 stream whose tail was truncated mid-sequence', () => {
    const full = Buffer.from('✗ deploy → │ 中文', 'utf8')
    // Drop the final continuation byte of 文 (e6 96 87 → e6 96).
    const truncated = full.subarray(0, full.length - 1)
    const out = decodeShellBytes(truncated, 'gbk')
    // Everything before the cut survives; the cut bytes become U+FFFD.
    expect(out.startsWith('✗ deploy → │ 中')).toBe(true)
    expect(out).toContain('✗')
    expect(out).not.toContain('鉁') // the gbk mojibake form of ✗
    expect(out).not.toContain('鈹') // the gbk mojibake form of │
  })

  // The tail-strip rescue must only fire on a real truncated UTF-8 sequence.
  // A GBK stream that happens to become valid UTF-8 after dropping a trailing
  // byte must still fall through to the codepage: [C4 A1 B2] is GBK 摹 + a
  // stray byte, NOT UTF-8 模 + U+FFFD.
  it('does not steal a truncated GBK stream via the tail-strip rescue', () => {
    const bytes = Buffer.from([0xc4, 0xa1, 0xb2]) // GBK 摹 + trailing stray
    expect(decodeShellBytes(bytes, 'gbk')).toBe('摹�')
  })

  // 1024 GBK hanzi (lead E0-EF × trail 80-BF) are byte-identical to a
  // truncated 3-byte UTF-8 sequence. The rescue must not fire on them when
  // the prefix is ASCII-only — ASCII proves nothing about the writer's
  // encoding, so the codepage wins and the hanzi survives.
  it('does not swallow a complete GBK hanzi whose bytes mimic a truncated UTF-8 tail', () => {
    // "done: " + GBK 鄝 (E0 80) — the E0 is a 3-byte UTF-8 lead, 80 a
    // continuation, so a shape-only guard calls this a truncated tail.
    const bytes = Buffer.concat([Buffer.from('done: ', 'ascii'), Buffer.from([0xe0, 0x80])])
    expect(decodeShellBytes(bytes, 'gbk')).toBe('done: 鄝')
  })

  it('still rescues a truncated UTF-8 tail when the prefix proves UTF-8', () => {
    // "✗ ok: " (multi-byte UTF-8 in the prefix) + truncated 文 (e6 96).
    const prefix = Buffer.from('✗ ok: ', 'utf8')
    const bytes = Buffer.concat([prefix, Buffer.from([0xe6, 0x96])])
    const out = decodeShellBytes(bytes, 'gbk')
    expect(out.startsWith('✗ ok: ')).toBe(true)
    expect(out.endsWith('�')).toBe(true)
    expect(out).not.toContain('鈹')
  })

  // Whole-capture truncation: the buffer IS the incomplete sequence. There
  // is no prefix to gather evidence from, and a lone GBK hanzi is not a
  // plausible single-chunk capture here — U+FFFD is the honest answer. The
  // off-by-one (strip === length) used to skip this and decode it as GBK.
  it('replaces a whole-buffer incomplete sequence with U+FFFD', () => {
    expect(decodeShellBytes(Buffer.from([0xe2, 0x80]), 'gbk')).toBe('�') // 「…」前半
    expect(decodeShellBytes(Buffer.from([0xf0, 0x9f]), 'gbk')).toBe('�') // emoji 前半
    expect(decodeShellBytes(Buffer.from([0xe2, 0x9c]), 'gbk')).toBe('�') // ✗ 前半
  })
})
