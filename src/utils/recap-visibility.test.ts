import { describe, it, expect } from 'vitest'
import { shouldMountRecapWindow } from './recap-visibility'

// Mount policy for the floating RecapWindow. Every case starts from the
// normal open path (recap present, not dismissed, search closed) and flips
// exactly ONE input, so a failure names the leg that broke.
describe('shouldMountRecapWindow', () => {
  const base = {
    recapOpen: true,
    searchOpen: false,
    hasRecap: true,
    hasOlder: true,
    hasPinnedUserMessage: false,
  }

  it('mounts on the normal open path', () => {
    expect(shouldMountRecapWindow(base)).toBe(true)
  })

  it('stays mounted while older history remains unloaded, even with no user message above the viewport (page-boundary flicker guard)', () => {
    // 深爬历史时每个页边界 pinned 信号都会短暂置 null：窗口头的第一条用户
    // 消息先进入视口，更早的页 prepend 落地后才重新置位。hasOlder 为 true
    // 期间卡片必须纹丝不动，否则每翻一页闪一次。
    expect(
      shouldMountRecapWindow({ ...base, hasOlder: true, hasPinnedUserMessage: false }),
    ).toBe(true)
  })

  it('mounts with all history loaded while a user message still sits above the viewport', () => {
    expect(
      shouldMountRecapWindow({ ...base, hasOlder: false, hasPinnedUserMessage: true }),
    ).toBe(true)
  })

  it('hides at the transcript top: all history loaded and no user message above the viewport', () => {
    // 到顶（或整场不足一屏）：卡片只会遮挡用户上来要读的开头内容。
    expect(
      shouldMountRecapWindow({ ...base, hasOlder: false, hasPinnedUserMessage: false }),
    ).toBe(false)
  })

  it('hides when dismissed for this generation', () => {
    expect(shouldMountRecapWindow({ ...base, recapOpen: false })).toBe(false)
  })

  it('hides while search is open', () => {
    expect(shouldMountRecapWindow({ ...base, searchOpen: true })).toBe(false)
  })

  it('hides when the session has no recap', () => {
    expect(shouldMountRecapWindow({ ...base, hasRecap: false })).toBe(false)
  })
})
