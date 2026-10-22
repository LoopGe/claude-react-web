import { createContext, useContext } from 'react'

/** Context carrying the result-consumed predicate for MessageView.
 *
 *  The value is an IDENTITY-STABLE wrapper that delegates to the newest
 *  predicate (MessageList's `resultConsumedCtx`), NOT the `makeResultConsumed`
 *  output itself. It has to be: the predicate is rebuilt whenever a source
 *  Map/Set changes, and a fresh function here would churn the context and
 *  re-render every mounted MessageView, defeating its own `memo`.
 *
 *  It is therefore NOT "the same instance" the item filter uses.
 *  `buildTranscriptRows` / `willRenderEmpty` are called directly with the
 *  changing `isResultConsumed` (its identity is what rebuilds the rows), while
 *  MessageView gets this stable wrapper plus a `consumedKey` prop so `memo`
 *  can still tell when its orphan-bubble filter would change. Two functions
 *  over one ref — do not re-collapse them.
 *
 *  The default rejects every id — safe because a MessageView is only ever
 *  rendered inside MessageList's provider. */
export const ResultConsumedCtx = createContext<(id: string) => boolean>(() => false)

export function useResultConsumed(): (id: string) => boolean {
  return useContext(ResultConsumedCtx)
}
