import { beforeEach, describe, expect, it } from 'vitest'
import type { UpdateInfo } from '../shared/update-info.js'
import { publishUpdateInfo, subscribeUpdateInfo, __resetUpdateInfoHubForTests } from './update-info-hub.js'

const BASE: UpdateInfo = {
  current: '1.0.0',
  packageName: 'claude-react-web',
  installMethod: 'global',
  hasUpdate: false,
  source: 'npm',
}
const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({ ...BASE, ...over })

const flush = () => new Promise((r) => setImmediate(r))

function drain(sub: ReturnType<typeof subscribeUpdateInfo>) {
  const received: UpdateInfo[] = []
  void (async () => { for await (const v of sub.iterable) received.push(v) })()
  return received
}

describe('update-info hub', () => {
  beforeEach(() => {
    __resetUpdateInfoHubForTests()
  })

  it('fans out the first publish and stays silent on an identical second', async () => {
    const sub = subscribeUpdateInfo()
    const received = drain(sub)
    publishUpdateInfo(info({ latest: '1.1.0', hasUpdate: true }))
    await flush()
    expect(received).toHaveLength(1)
    publishUpdateInfo(info({ latest: '1.1.0', hasUpdate: true }))
    await flush()
    expect(received).toHaveLength(1)
    sub.unsubscribe()
  })

  it.each([
    ['latest', { latest: '1.1.0' }],
    ['deprecated', { deprecated: 'please upgrade' }],
    ['error', { error: 'registry unreachable' }],
    ['updateAppliedToDisk', { updateAppliedToDisk: true }],
    ['disabled', { disabled: true }],
  ] as Array<[string, Partial<UpdateInfo>]>)('a change to %s alone triggers fan-out', async (_key, over) => {
    const sub = subscribeUpdateInfo()
    const received = drain(sub)
    publishUpdateInfo(info())
    await flush()
    expect(received).toHaveLength(1)
    publishUpdateInfo(info(over))
    await flush()
    expect(received).toHaveLength(2)
    expect(received[1]).toEqual(info(over))
    sub.unsubscribe()
  })

  it('a non-meaningful change (checkedAt alone) is silent', async () => {
    const sub = subscribeUpdateInfo()
    const received = drain(sub)
    publishUpdateInfo(info({ latest: '1.1.0' }))
    await flush()
    publishUpdateInfo(info({ latest: '1.1.0', checkedAt: 123 }))
    await flush()
    expect(received).toHaveLength(1)
    sub.unsubscribe()
  })

  it('snapshot reflects the latest received even when the last publish was silent', async () => {
    const sub = subscribeUpdateInfo()
    expect(sub.snapshot).toBeNull()
    publishUpdateInfo(info({ latest: '1.1.0' }))
    expect(sub.snapshot).toEqual(info({ latest: '1.1.0' }))
    publishUpdateInfo(info({ latest: '1.1.0', checkedAt: 999 }))
    expect(sub.snapshot?.checkedAt).toBe(999)
    sub.unsubscribe()
  })

  it('two subscribers both receive; unsubscribe stops only that one', async () => {
    const a = subscribeUpdateInfo()
    const b = subscribeUpdateInfo()
    const ra = drain(a)
    const rb = drain(b)
    publishUpdateInfo(info({ latest: '1.1.0' }))
    await flush()
    expect(ra).toHaveLength(1)
    expect(rb).toHaveLength(1)
    a.unsubscribe()
    publishUpdateInfo(info({ latest: '1.2.0' }))
    await flush()
    expect(ra).toHaveLength(1)
    expect(rb).toHaveLength(2)
    b.unsubscribe()
  })
})