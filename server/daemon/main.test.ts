import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parseDaemonArgv, isSingletonBlocked, type DaemonStatusLike } from './main.js'

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
