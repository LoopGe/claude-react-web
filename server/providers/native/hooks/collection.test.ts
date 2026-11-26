// server/providers/native/hooks/collection.test.ts
import { describe, it, expect } from 'vitest'
import type { HookEvent, SessionHooksConfig } from '../../../../shared/hooks.js'
import { collectForEvent } from './collection.js'
import type { HookSource } from './types.js'

/** Test-local source factory — the production flag source is constructed by a
 *  later task (native-session); collection only needs ordered matcher lists. */
function sourceOf(kind: HookSource['kind'], config: SessionHooksConfig): HookSource {
  return { kind, collect: (event) => config[event] ?? [] }
}

describe('collectForEvent', () => {
  it('returns flag matchers before settings matchers (array order = precedence order)', () => {
    const flag = sourceOf('flag', {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'flag.sh' }] }],
    })
    const settings = sourceOf('settings', {
      PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'settings.sh' }] }],
    })
    expect(collectForEvent([flag, settings], 'PreToolUse')).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'flag.sh' }] },
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'settings.sh' }] },
    ])
  })

  it('dedups an identical hook across sources, keeping the earlier (flag) copy wholesale', () => {
    const flagHook = { type: 'command', command: 'guard.sh', timeout: 5 } as const
    const flag = sourceOf('flag', { PreToolUse: [{ matcher: 'Bash', hooks: [flagHook] }] })
    const settings = sourceOf('settings', {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: 'guard.sh', timeout: 30 },
          { type: 'command', command: 'audit.sh' },
        ],
      }],
    })
    const result = collectForEvent([flag, settings], 'PreToolUse')
    // guard.sh appears once — the flag copy (timeout 5), not the settings copy
    // (timeout 30); group boundaries stay as concatenated, no regrouping.
    expect(result).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh', timeout: 5 }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] },
    ])
    // The surviving guard hook IS the flag source's object, not a rebuilt copy.
    expect(result[0].hooks[0]).toBe(flagHook)
  })

  it('returns [] for no sources and for sources with nothing on the event', () => {
    expect(collectForEvent([], 'PreToolUse')).toEqual([])
    expect(collectForEvent([sourceOf('flag', {}), sourceOf('settings', {})], 'Stop')).toEqual([])
    const flag = sourceOf('flag', { PreToolUse: [{ hooks: [{ type: 'command', command: 'x.sh' }] }] })
    expect(collectForEvent([flag], 'Stop')).toEqual([])
  })

  it('treats the matcher as part of hook identity — same command, different matchers both survive', () => {
    const flag = sourceOf('flag', { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }] })
    const settings = sourceOf('settings', { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'guard.sh' }] }] })
    expect(collectForEvent([flag, settings], 'PreToolUse')).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] },
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'guard.sh' }] },
    ])
  })

  it('normalizes absent and empty matcher to one identity', () => {
    const flag = sourceOf('flag', { PreToolUse: [{ hooks: [{ type: 'command', command: 'guard.sh' }] }] })
    const settings = sourceOf('settings', { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'guard.sh' }] }] })
    expect(collectForEvent([flag, settings], 'PreToolUse')).toEqual([
      { hooks: [{ type: 'command', command: 'guard.sh' }] },
    ])
  })

  it('treats hook type as part of identity — prompt and agent with the same prompt both survive', () => {
    const flag = sourceOf('flag', { Stop: [{ hooks: [{ type: 'prompt', prompt: 'check the diff' }] }] })
    const settings = sourceOf('settings', { Stop: [{ hooks: [{ type: 'agent', prompt: 'check the diff' }] }] })
    expect(collectForEvent([flag, settings], 'Stop')).toEqual([
      { hooks: [{ type: 'prompt', prompt: 'check the diff' }] },
      { hooks: [{ type: 'agent', prompt: 'check the diff' }] },
    ])
  })

  it('dedups http hooks by url — the earlier copy keeps its own headers', () => {
    const flag = sourceOf('flag', {
      PreToolUse: [{ hooks: [{ type: 'http', url: 'https://example.com/hook', headers: { 'X-Flag': '1' } }] }],
    })
    const settings = sourceOf('settings', {
      PreToolUse: [{ hooks: [{ type: 'http', url: 'https://example.com/hook', headers: { 'X-Settings': '1' } }] }],
    })
    expect(collectForEvent([flag, settings], 'PreToolUse')).toEqual([
      { hooks: [{ type: 'http', url: 'https://example.com/hook', headers: { 'X-Flag': '1' } }] },
    ])
  })

  it('dedups prompt hooks by prompt text, not model', () => {
    const flag = sourceOf('flag', { Stop: [{ hooks: [{ type: 'prompt', prompt: 'review', model: 'claude-a' }] }] })
    const settings = sourceOf('settings', { Stop: [{ hooks: [{ type: 'prompt', prompt: 'review', model: 'claude-b' }] }] })
    expect(collectForEvent([flag, settings], 'Stop')).toEqual([
      { hooks: [{ type: 'prompt', prompt: 'review', model: 'claude-a' }] },
    ])
  })

  it('dedups repeated hooks within one source too, first occurrence wins', () => {
    const flag = sourceOf('flag', {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: 'guard.sh', timeout: 5 },
          { type: 'command', command: 'guard.sh', timeout: 30 },
        ],
      }],
    })
    expect(collectForEvent([flag], 'PreToolUse')).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh', timeout: 5 }] },
    ])
  })

  it('drops a matcher group whose hooks all deduped away', () => {
    const flag = sourceOf('flag', { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }] })
    const settings = sourceOf('settings', { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }] })
    expect(collectForEvent([flag, settings], 'PreToolUse')).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] },
    ])
  })

  it('passes the event to every source and re-collects per event', () => {
    const seen: HookEvent[] = []
    const spy: HookSource = { kind: 'flag', collect: (event) => { seen.push(event); return [] } }
    const settings = sourceOf('settings', {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'pre.sh' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'stop.sh' }] }],
    })
    expect(collectForEvent([spy, settings], 'Stop')).toEqual([{ hooks: [{ type: 'command', command: 'stop.sh' }] }])
    expect(seen).toEqual(['Stop'])
    expect(collectForEvent([settings], 'PreToolUse')).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'pre.sh' }] },
    ])
  })

  it('does not mutate the source configs', () => {
    const config: SessionHooksConfig = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
    }
    const before = structuredClone(config)
    collectForEvent([sourceOf('flag', config), sourceOf('settings', config)], 'PreToolUse')
    expect(config).toEqual(before)
  })
})
