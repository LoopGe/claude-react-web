import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
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

/** Poll until `process.kill(pid, 0)` throws — the process is gone. */
async function expectGone(pid: number, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await new Promise((r) => setTimeout(r, 20))
    } catch {
      return
    }
  }
  throw new Error(`pid ${pid} still alive after ${ms}ms`)
}

describe.runIf(process.platform === 'win32')('execCommand win32 tree kill', () => {
  // cmd.exe is the direct child; `node t.js` runs as its descendant. Aborting
  // must kill the whole tree — a direct-child kill leaves the sleeping node
  // process behind (the orphan gap this pin closes). The descendant prints its
  // own pid, captured live through onProgress before the abort.
  it('abort kills the sleeping descendant, not just the shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'exec-tree-'))
    const ac = new AbortController()
    let descendantPid = 0
    let capturePid: (line: string) => void = () => {}
    try {
      await writeFile(join(dir, 't.js'), 'console.log(process.pid); setInterval(() => {}, 1000)', 'utf8')
      const pidReady = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('child printed no pid within 5s')), 5000)
        capturePid = (line) => {
          const m = /^(\d+)\r?$/.exec(line)
          if (m) {
            clearTimeout(timer)
            resolve(Number(m[1]))
          }
        }
      })
      const run = execCommand(dir, 'node t.js', {
        signal: ac.signal,
        onProgress: (line) => capturePid(line),
      })
      descendantPid = await pidReady
      ac.abort()
      const result = await run
      expect(result.interrupted).toBe(true)
      await expectGone(descendantPid)
    } finally {
      // Backstop: settle a still-running exec and kill the sleeper so a failed
      // assertion never leaks it into the process table.
      ac.abort()
      if (descendantPid > 0) {
        spawnSync('taskkill', ['/PID', String(descendantPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      }
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
