import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { writeMarker, readMarker } from './control.js'
import { parseDaemonArgv, isSingletonBlocked, openServerLogStream, sweepStaleMarkers, type DaemonStatusLike } from './main.js'

describe('parseDaemonArgv', () => {
  it('reads --state-dir in both spellings and defaults to ~/.claude-react-web', () => {
    expect(parseDaemonArgv(['--state-dir', '/a/b']).stateDir).toBe('/a/b')
    expect(parseDaemonArgv(['--state-dir=/a/b']).stateDir).toBe('/a/b')
    expect(parseDaemonArgv([]).stateDir).toBe(join(homedir(), '.claude-react-web'))
    expect(() => parseDaemonArgv(['--unknown'])).toThrow(/unknown option/i)
    expect(() => parseDaemonArgv(['extra-positional'])).toThrow(/unexpected argument/i)
    expect(() => parseDaemonArgv(['--state-dir'])).toThrow(/requires a value/i)
  })
})

describe('isSingletonBlocked', () => {
  const alive = () => true
  const dead = () => false
  const s = (over: Partial<DaemonStatusLike>): DaemonStatusLike => ({
    daemonPid: 42, state: 'running', updatedAt: Date.now(), ...over,
  })
  it('blocks when a fresh heartbeat points at a live pid', () => {
    expect(isSingletonBlocked(s({}), alive)).toBe(true)
  })
  it('allows when the heartbeat is stale or the pid is dead', () => {
    expect(isSingletonBlocked(s({ updatedAt: Date.now() - 60_000 }), alive)).toBe(false)
    expect(isSingletonBlocked(s({}), dead)).toBe(false)
  })
  it('allows when there is no status file at all', () => {
    expect(isSingletonBlocked(null, alive)).toBe(false)
  })
})

describe('openServerLogStream (review fix #1)', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('daemon-log') })
  afterEach(() => rmRf(dir))

  it('creates <stateDir>/daemon on first spawn and opens server.log for append', async () => {
    // Regression: on a FRESH state dir the daemon/ subdir does not exist when
    // the first child spawns — createWriteStream fired an unhandled ENOENT
    // and crashed the daemon before its first heartbeat.
    expect(existsSync(join(dir, 'daemon'))).toBe(false)
    const stream = openServerLogStream(dir)
    await new Promise<void>((resolve) => stream.once('open', () => resolve()))
    expect(existsSync(join(dir, 'daemon', 'server.log'))).toBe(true)
    stream.end()
  })
})

describe('sweepStaleMarkers (review fix #2/#3)', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('daemon-sweep') })
  afterEach(() => rmRf(dir))

  it('clears orphaned stop/restart/start markers at daemon boot', async () => {
    await writeMarker(dir, 'stop')
    await writeMarker(dir, 'restart')
    await writeMarker(dir, 'start')
    await sweepStaleMarkers(dir)
    expect(await readMarker(dir, 'stop')).toBe(false)
    expect(await readMarker(dir, 'restart')).toBe(false)
    expect(await readMarker(dir, 'start')).toBe(false)
  })
})
