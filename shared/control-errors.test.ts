import { describe, expect, it } from 'vitest'
import { classifyControlError } from './control-errors.js'

describe('classifyControlError', () => {
  it('maps the CLI transport "Connection closed" failure to connection-closed', () => {
    const info = classifyControlError('Connection closed')
    expect(info?.code).toBe('connection-closed')
    expect(info?.title).toBeTruthy()
    expect(info?.hint).toContain('terminal')
  })

  it('states only what the transport text proves — start failure AND later crash are both acknowledged', () => {
    const hint = classifyControlError('Connection closed')?.hint ?? ''
    expect(hint).toContain('failed to start')
    expect(hint).toContain('crashed')
  })

  it('matches "Connection closed" case-insensitively', () => {
    expect(classifyControlError('connection CLOSED')?.code).toBe('connection-closed')
  })

  it('maps timeout failures to timeout, including the socket-level ETIMEDOUT form', () => {
    expect(classifyControlError('Request timed out after 30s')?.code).toBe('timeout')
    expect(classifyControlError('connection timeout')?.code).toBe('timeout')
    expect(classifyControlError('connect ETIMEDOUT 1.2.3.4:443')?.code).toBe('timeout')
  })

  it('does not match "timeout" embedded in a larger word (timeoutMs)', () => {
    expect(classifyControlError('option timeoutMs is invalid')).toBeNull()
  })

  it('maps spawn failures (ENOENT / EINVAL / spawn) to spawn-failure', () => {
    expect(classifyControlError('spawn npm ENOENT')?.code).toBe('spawn-failure')
    expect(classifyControlError('spawn EINVAL')?.code).toBe('spawn-failure')
  })

  it('classifies a spawn failure whose echoed argv mentions "timeout" as spawn, not timeout', () => {
    expect(classifyControlError('spawn npx --request-timeout 30 ENOENT')?.code).toBe('spawn-failure')
  })

  it('classifies a launch failure that mentions the close as spawn, not connection-closed', () => {
    expect(classifyControlError('spawn npx: connection closed')?.code).toBe('spawn-failure')
  })

  it('does not match the word "spawn" embedded in a larger word (respawn throttling)', () => {
    expect(classifyControlError('supervisor respawn throttled')).toBeNull()
  })

  it('returns null for unknown errors so callers keep the raw text', () => {
    expect(classifyControlError('Some totally unexpected failure')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(classifyControlError('')).toBeNull()
  })
})
