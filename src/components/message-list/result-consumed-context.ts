import { createContext, useContext } from 'react'

/** Context carrying the single result-consumed predicate instance for one
 *  render. MessageList builds it (makeResultConsumed) and provides it; both
 *  the item filter (willRenderEmpty, called directly with the same value) and
 *  MessageView (via useResultConsumed) read it. The default rejects every id
 *  — safe because a MessageView is only ever rendered inside MessageList's
 *  provider. */
export const ResultConsumedCtx = createContext<(id: string) => boolean>(() => false)

export function useResultConsumed(): (id: string) => boolean {
  return useContext(ResultConsumedCtx)
}
