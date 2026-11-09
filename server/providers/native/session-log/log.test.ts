// log.test.ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeSessionLog, deleteNativeSessionLog, hasNativeSessionLog, loadNativeSessionLogSync } from './log.js'
import { nativeSessionLogPath } from './paths.js'

let dir: string
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
const fresh = async () => { dir = await mkdtemp(join(tmpdir(), 'native-log-')); return dir }

const userEvent = (uuid: string) => ({ type: 'user' as const, uuid, session_id: 's1', parent_tool_use_id: null as null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user' as const, content: [{ type: 'text', text: 'hi' }] } })

describe('NativeSessionLog', () => {
  it('creates, appends, reloads in order and survives a torn tail', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1'))
    log.append({ type: 'turn/end', reason: 'completed' })
    await log.flush()
    await log.close()
    await writeFile(nativeSessionLogPath(stateDir, 's1'), '{"seq":2,"type":"assi', { flag: 'a' })
    const snapped = loadNativeSessionLogSync(stateDir, 's1')!
    expect(snapped.events.map((e) => e.type)).toEqual(['user', 'turn/end'])
    const reopened = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: true })
    reopened.append({ type: 'session/end-seed' })
    await reopened.flush()
    expect(loadNativeSessionLogSync(stateDir, 's1')!.events.map((e) => e.seq)).toEqual([0, 1, 2])
    await reopened.close()
  })
  it('refuses a fresh open over an existing log', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1')); await log.flush(); await log.close()
    expect(() => NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })).toThrow(/exists/)
  })
  it('takes over the writer: committed lines survive, post-takeover appends do not', async () => {
    const stateDir = await fresh()
    const a = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    a.append(userEvent('u1'))
    await a.flush()
    const b = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: true })
    a.append(userEvent('stale'))
    b.append({ type: 'session/end-seed' })
    await b.flush()
    expect(loadNativeSessionLogSync(stateDir, 's1')!.events.map((e) => e.type)).toEqual(['user', 'session/end-seed'])
    await a.close(); await b.close()
  })
  it('keeps writers for the same id in different state dirs independent', async () => {
    const stateDirA = await fresh()
    const stateDirB = await mkdtemp(join(tmpdir(), 'native-log-'))
    try {
      const a = NativeSessionLog.open({ stateDir: stateDirA, id: 's1', cwd: '/repo', resume: false })
      const b = NativeSessionLog.open({ stateDir: stateDirB, id: 's1', cwd: '/repo', resume: false })
      a.append(userEvent('u1'))
      await a.flush()
      expect(loadNativeSessionLogSync(stateDirA, 's1')!.events.map((e) => e.type)).toEqual(['user'])
      await a.close(); await b.close()
    } finally {
      await rm(stateDirB, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
  it('reports existence without parsing and deletes the directory', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1')); await log.flush(); await log.close()
    expect(await hasNativeSessionLog(stateDir, 's1')).toBe(true)
    expect(await deleteNativeSessionLog(stateDir, 's1')).toBe(true)
    expect(await hasNativeSessionLog(stateDir, 's1')).toBe(false)
  })
  it('rejects an unknown version on load', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1')); await log.flush(); await log.close()
    const path = nativeSessionLogPath(stateDir, 's1')
    const lines = (await readFile(path, 'utf8')).split('\n')
    lines[0] = lines[0].replace('"v":1', '"v":2')
    await writeFile(path, lines.join('\n'))
    expect(() => loadNativeSessionLogSync(stateDir, 's1')).toThrow(/unsupported|version/i)
  })
})