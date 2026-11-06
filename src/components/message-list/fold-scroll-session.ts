import { bodyHeightDelta, type BodyHeightSnapshot } from '../collapse-animation'
import { snapToDevicePx } from '../../utils/pixel-grid'

export interface FoldFrame {
  bodyHeights: BodyHeightSnapshot
  itemListDelta: number | null
  contentDelta: number
  paddingDelta: number
  itemListHeight: number
  contentHeight: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  devicePixelRatio: number
}

export type FoldSample =
  | { kind: 'delta'; delta: number; ledger: number; transform: number }
  | { kind: 'absolute-bottom'; reason: 'new-body' | 'other-growth' | 'pending' }

export interface FoldScrollSession {
  readonly token: number
  requestAbsoluteBottom(): void
  reconcileAbsolute(scrollTop: number): void
  sample(frame: FoldFrame): FoldSample
}

export function createFoldScrollSession(start: { token: number; from: number; to: number }): FoldScrollSession {
  let bodySnapshot: BodyHeightSnapshot | null = null
  let ledger: number | null = null
  let otherResidual = 0
  let pending = false

  return {
    token: start.token,
    requestAbsoluteBottom() {
      pending = true
    },
    reconcileAbsolute(scrollTop) {
      ledger = scrollTop
    },
    sample(frame) {
      const foldDelta = bodyHeightDelta(bodySnapshot, frame.bodyHeights)
      bodySnapshot = frame.bodyHeights
      otherResidual += frame.contentDelta - (foldDelta ?? 0)
      const otherGrowth = Math.abs(otherResidual) >= 1
      const fallbackDelta = frame.itemListDelta === null
        ? null
        : frame.itemListDelta - frame.paddingDelta
      const delta = pending || otherGrowth ? null : foldDelta ?? fallbackDelta

      if (delta === null) {
        const reason = pending ? 'pending' : otherGrowth ? 'other-growth' : 'new-body'
        if (pending || otherGrowth) otherResidual = 0
        pending = false
        ledger = null
        return { kind: 'absolute-bottom', reason }
      }

      ledger = ledger === null
        ? delta < 0 ? frame.scrollTop : frame.scrollTop + delta
        : ledger + delta
      const maximum = frame.scrollHeight - frame.clientHeight
      ledger = Math.max(0, Math.min(ledger, maximum))
      const transform = snapToDevicePx(ledger, frame.devicePixelRatio) - ledger
      return { kind: 'delta', delta, ledger, transform }
    },
  }
}
