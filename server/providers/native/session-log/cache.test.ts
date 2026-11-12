import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nativeHistoryCache } from './cache.js'
import type { NativeEventInput } from './format.js'
import { NativeSessionLog, deleteNativeSessionLog } from './log.js'

let dir: string | undefined

afterEach(async () => {
  nativeHistoryCache.invalidate('s1')
  if (dir) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    dir = undefined
  }
})

async function openLog(): Promise<NativeSessionLog> {
  dir = await mkdtemp(join(tmpdir(), 'native-cache-'))
  return NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
}

function origin(id: string): NativeEventInput {
  return {
    type: 'assistant',
    uuid: `origin-${id}`,
    session_id: 's1',
    parent_tool_use_id: null,
    timestamp: '2026-11-12T00:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id,
        name: 'Agent',
        input: { description: `label ${id}`, prompt: `prompt ${id}` },
      }],
    },
  }
}

function descriptor(id: string): NativeEventInput {
  return {
    type: 'subagent/descriptor',
    toolUseId: id,
    parentToolUseId: null,
    kind: 'agent',
    toolName: 'Agent',
    label: `label ${id}`,
    depth: 1,
    profile: null,
    timestamp: '2026-11-12T00:00:01.000Z',
  }
}

describe('native history cache subagent catalogs', () => {
  it('updates the catalog on a descriptor-only append without replacing renderable lines', async () => {
    const stateDir = dir = await mkdtemp(join(tmpdir(), 'native-cache-'))
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(origin('a'))
    await log.flush()

    const first = await nativeHistoryCache.load(stateDir, 's1')
    expect(first?.lines).toHaveLength(1)
    expect(first?.subagents.entries).toEqual([])

    log.append(descriptor('a'))
    await log.flush()
    const second = await nativeHistoryCache.load(stateDir, 's1')

    expect(second?.lines).toBe(first?.lines)
    expect(second?.subagents).not.toBe(first?.subagents)
    expect(second?.subagents.entries.map((entry) => entry.agentId)).toEqual(['a'])
    expect(second?.subagents.byId.get('a')).toMatchObject({
      metadataComplete: true,
      prompt: 'prompt a',
      timestamp: '2026-11-12T00:00:01.000Z',
    })

    const freshHit = await nativeHistoryCache.load(stateDir, 's1')
    expect(freshHit?.lines).toBe(second?.lines)
    expect(freshHit?.subagents).toBe(second?.subagents)
    await log.close()
  })

  it('does not return a deleted catalog after invalidation and same-id recreation', async () => {
    const log = await openLog()
    const stateDir = dir!
    log.append(origin('old'))
    log.append(descriptor('old'))
    await log.flush()
    await log.close()

    const first = await nativeHistoryCache.load(stateDir, 's1')
    expect(first?.subagents.entries.map((entry) => entry.agentId)).toEqual(['old'])

    await deleteNativeSessionLog(stateDir, 's1')
    nativeHistoryCache.invalidate('s1')
    expect(await nativeHistoryCache.load(stateDir, 's1')).toBeNull()

    const replacement = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    replacement.append(origin('new'))
    replacement.append(descriptor('new'))
    await replacement.flush()
    await replacement.close()

    const recreated = await nativeHistoryCache.load(stateDir, 's1')
    expect(recreated?.subagents.entries.map((entry) => entry.agentId)).toEqual(['new'])
    expect(recreated?.subagents.byId.has('old')).toBe(false)
  })
})
