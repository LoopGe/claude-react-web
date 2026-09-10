import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const MAX_STDERR_BYTES = 5 * 1024 * 1024
const KEEP_LAST_BYTES = 1024 * 1024

function sidFile(logsDir: string | undefined, sid: string, kind: 'stderr' | 'debug'): string | null {
  if (!logsDir || !sid) return null
  return kind === 'stderr'
    ? join(logsDir, `cli-stderr-${sid}.jsonl`)
    : join(logsDir, `cli-${sid}.log`)
}

async function statSize(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).size
  } catch {
    return 0
  }
}

/** Append one stderr line to the session's bounded jsonl tail. */
export async function appendStderrLine(
  logsDir: string | undefined,
  sid: string,
  line: string,
): Promise<void> {
  const file = sidFile(logsDir, sid, 'stderr')
  if (!file) return
  const entry = JSON.stringify({ ts: Date.now(), line })
  const lineLen = entry.length + 1
  const size = await statSize(file)
  await fs.mkdir(join(file, '..'), { recursive: true }).catch(() => undefined)
  if (size > 0 && size + lineLen > MAX_STDERR_BYTES) {
    const raw = await fs.readFile(file, 'utf8').catch(() => '')
    const kept = raw.slice(Math.max(0, raw.length - KEEP_LAST_BYTES))
    await fs.writeFile(file, kept + entry + '\n', 'utf8')
  } else {
    await fs.appendFile(file, entry + '\n', 'utf8')
  }
}

/** Read the last `n` stderr lines (oldest→newest), each reduced to its
 *  `line` payload (falls back to the raw line on parse failure). */
export async function readStderrTail(
  logsDir: string | undefined,
  sid: string,
  n = 200,
): Promise<string[]> {
  const file = sidFile(logsDir, sid, 'stderr')
  if (!file) return []
  const raw = await fs.readFile(file, 'utf8').catch(() => '')
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-n)
    .map((l) => {
      try {
        const o = JSON.parse(l) as { line?: unknown }
        return typeof o.line === 'string' ? o.line : l
      } catch {
        return l
      }
    })
}

/** Info about the session's CLI debug log file (SDK `Options.debugFile`). */
export async function cliLogInfo(
  logsDir: string | undefined,
  sid: string,
): Promise<{ exists: boolean; path?: string; size?: number }> {
  const file = sidFile(logsDir, sid, 'debug')
  if (!file) return { exists: false }
  try {
    const st = await fs.stat(file)
    return { exists: true, path: file, size: st.size }
  } catch {
    return { exists: false }
  }
}

/** Delete stale `cli-*.log` and `cli-stderr-*.jsonl` files older than
 *  `maxAgeMs`. Returns the count removed. Never throws. */
export async function cleanupCliLogs(
  logsDir: string | undefined,
  maxAgeMs = 14 * 24 * 3600 * 1000,
): Promise<number> {
  if (!logsDir) return 0
  let removed = 0
  const now = Date.now()
  const entries = await fs.readdir(logsDir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (!e.isFile()) continue
    if (!/^cli-.*\.log$/.test(e.name) && !/^cli-stderr-.*\.jsonl$/.test(e.name)) continue
    const p = join(logsDir, e.name)
    try {
      const st = await fs.stat(p)
      if (now - st.mtimeMs > maxAgeMs) {
        await fs.unlink(p)
        removed++
      }
    } catch {
      /* ignore individual failures */
    }
  }
  return removed
}
