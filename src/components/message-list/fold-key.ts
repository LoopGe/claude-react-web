// Pure helpers for the long user-message body fold. Separate module so the
// FoldableBody component file stays component-only (react-refresh rule) and
// so non-component callers (MessageList) can import the key function without
// pulling the component graph.
import { extractUserText } from './rendering'
import { getBlocks } from '../../session-store/normalize'
import type { SdkMessage } from '../../types'

/** Fold threshold in px (~12 lines at default type scale). Both the
 *  overflow test and the inline max-height read this one constant. */
export const FOLD_MAX_PX = 240

/** Content-derived expansion key for a real-user message body.
 *
 *  Deliberately NOT the row id: `ackUserMessage` re-keys the optimistic
 *  placeholder from pendingId to the server-minted uuid once the POST
 *  resolves (reducer.ts), the WS echo path can replace the placeholder the
 *  same way, and history re-materialization re-keys top-level prompts too —
 *  a uuid-keyed expansion Set would miss after any of them and snap the
 *  body shut under the user. All of those paths rebuild the row with
 *  VERBATIM `message.content`, so content is the identity that survives.
 *
 *  KNOWN TRADE-OFF: two distinct messages with identical content share one
 *  key, so their expansion state is coupled (toggling one toggles both).
 *  Accepted after review: every disambiguator that survives the re-key
 *  paths above is worse — row id loses state on ack (the bug this
 *  replaced), row index breaks on history pagination, occurrence rank
 *  breaks when the same text exists in paged-in history, and receivedAt
 *  is stamped/overwritten by the ack itself. Cosmetic coupling on
 *  byte-identical text beats state loss on every message.
 *
 *  Images contribute length + a head slice of their base64 payload: the
 *  full payload would make per-render keying O(payload) on a 28 MB paste,
 *  while length+head distinguishes image-only messages that share empty
 *  text without ever materialising the whole string. */
export function userBodyFoldKey(msg: SdkMessage): string {
  const text = extractUserText(msg) ?? ''
  let images = ''
  for (const b of getBlocks(msg)) {
    if (b.type !== 'image') continue
    const data = (b as { source?: { data?: unknown } }).source?.data
    const part = typeof data === 'string' ? `${data.length}:${data.slice(0, 64)}` : '0:'
    images += images ? `,${part}` : part
  }
  return images ? `${text} ${images}` : text
}
