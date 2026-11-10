import type { SdkMessage } from '../../types'
import type { TranscriptItem } from '../../session-store/types'

/** A search-jump target. `ownerToolUseId` is set for tool_result hits, whose
 *  own message has no main-view row; the jump lands on the owning tool card. */
export interface RevealTarget {
  nonce: number
  /** Anchor seq (preferred by Chat's anchor request; unused by MessageList). */
  seq?: number
  messageUuid?: string
  ownerToolUseId?: string
}

function hasToolUse(msg: SdkMessage, id: string): boolean {
  const content = (msg as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return false
  return content.some((block) => {
    if (!block || typeof block !== 'object') return false
    const b = block as { type?: unknown; id?: unknown }
    return b.type === 'tool_use' && b.id === id
  })
}

/** The `items[]` index to scroll to. Owner first: a tool_result's own item has
 *  no row, so the owning tool_use is the visible target. Returns -1 when the
 *  target is not in the loaded transcript. */
export function resolveRevealItemIndex(
  items: readonly TranscriptItem[],
  target: Pick<RevealTarget, 'messageUuid' | 'ownerToolUseId'>,
): number {
  if (target.ownerToolUseId) {
    const owner = items.findIndex((item) => hasToolUse(item.msg, target.ownerToolUseId!))
    if (owner >= 0) return owner
  }
  if (target.messageUuid) {
    return items.findIndex((item) => item.msg.uuid === target.messageUuid)
  }
  return -1
}