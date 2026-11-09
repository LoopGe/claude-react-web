import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nativeSessionDir, nativeSessionLogPath, resolveNativeStateDir } from './paths.js'

describe('native session paths', () => {
  it('places the log under <stateDir>/native-sessions/<id>/session.v1.jsonl', () => {
    expect(nativeSessionLogPath('/state', 'abc')).toBe(join('/state', 'native-sessions', 'abc', 'session.v1.jsonl'))
    expect(nativeSessionDir('/state', 'abc')).toBe(join('/state', 'native-sessions', 'abc'))
  })
  it('rejects traversal ids', () => {
    expect(() => nativeSessionDir('/state', '../x')).toThrow(/Invalid session id/)
  })
  it('defaults to the app state dir', () => {
    expect(resolveNativeStateDir()).toMatch(/\.claude-react-web$/)
  })
})