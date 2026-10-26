import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execCommand, escapeXml } from './exec.js'

// These spawn a real child process through the same system shell `!` bash
// mode uses. Two constraints drive the test shape:
//   - the script source is pure ASCII writing raw bytes via Buffer.from, so
//     the file itself can't introduce an encoding variable;
//   - the command is `node t.js` with cwd = the temp dir, so no path quoting
//     goes through cmd.exe's argv parser.
// Node always writes UTF-8 to a pipe, so the bytes below are exactly what
// production sees from npm/npx/`skills`-style tools.

async function runBytes(bytes: number[], stream: 'stdout' | 'stderr' = 'stdout') {
  const dir = await mkdtemp(join(tmpdir(), 'exec-test-'))
  try {
    await writeFile(join(dir, 't.js'), `process.${stream}.write(Buffer.from([${bytes.join(',')}]))`, 'utf8')
    return await execCommand(dir, 'node t.js')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ✗ deploy → │ 中文 — the exact glyph mix from the `npx skills` screenshot.
const UTF8_LINE = [
  0xe2, 0x9c, 0x97, 0x20, 0x64, 0x65, 0x70, 0x6c, 0x6f, 0x79, 0x20,
  0xe2, 0x86, 0x92, 0x20, 0xe2, 0x94, 0x82, 0x20,
  0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87,
]

describe('execCommand output decoding', () => {
  it('keeps UTF-8 symbols from a Node child intact (regression: skills CLI mojibake)', async () => {
    // On a CP936 host the old decode (always gbk) turned these into 鉁鉁鉁鉁鉁/鈫鉁鉁鉁�.
    const r = await runBytes(UTF8_LINE)
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('✗ deploy → │ 中文')
  })

  it('keeps UTF-8 symbols on stderr intact', async () => {
    // 警告 ✗ →
    const bytes = [
      0xe8, 0xad, 0xa6, 0xe5, 0x91, 0x8a, 0x20,
      0xe2, 0x9c, 0x97, 0x20, 0xe2, 0x86, 0x92,
    ]
    const r = await runBytes(bytes, 'stderr')
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('警告 ✗ →')
    expect(r.stdout).toBe('')
  })

  it('leaves ASCII-only output unchanged', async () => {
    const r = await runBytes([0x6e, 0x70, 0x6d, 0x20, 0x77, 0x61, 0x72, 0x6e])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('npm warn')
  })
})

describe('escapeXml', () => {
  it('escapes only the three tag delimiters', () => {
    expect(escapeXml('a<b>c&d')).toBe('a&lt;b&gt;c&amp;d')
    expect(escapeXml('plain')).toBe('plain')
  })
})
