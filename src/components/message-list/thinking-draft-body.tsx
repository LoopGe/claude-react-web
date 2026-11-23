// Body of the in-place streaming thinking row — see
// docs/superpowers/specs/2026-11-23-streaming-thinking-design.md §5.4.
//
// TWO states, ONE controlled AnimatedDetails instance (a fresh closed mount
// would NOT play the fold animation — AnimatedCollapse pins height 0 on the
// initial closed path):
//  - streaming (done=false): open forced true; a summary click is swallowed
//    by the controlled value (no manual fold mid-stream, spec non-goal).
//  - done (block_stop arrived): open=false → the SAME instance animates
//    closed; the user can re-expand (userOpened). The closed DOM is
//    pixel-identical to the settled BlockView thinking block (same component,
//    same summary via thinkingPreviewText, same pre body) so the finalize
//    hand-off swaps renderers without a visual change.
// A FROZEN interrupted half-card (frozenText given) renders statically
// collapsed, uncontrolled, with the store subscription INERT — it must not
// churn on a later live thinking draft's flushes.

import { memo, useState } from 'react'
import { AnimatedDetails } from '../AnimatedCollapse'
import { useOptionalSessionField } from '../../session-store/selectors'
import { thinkingPreviewText } from './blocks'

export const ThinkingDraftBody = memo(function ThinkingDraftBody({ sessionId, frozenText }: {
  sessionId?: string
  frozenText?: string
}) {
  const thinkingDraft = useOptionalSessionField(frozenText != null ? undefined : sessionId, 'thinkingDraft')
  const text = frozenText ?? thinkingDraft?.text ?? ''
  const done = frozenText != null ? true : (thinkingDraft?.done ?? false)
  const [userOpened, setUserOpened] = useState(false)
  const frozen = frozenText != null
  return (
    <AnimatedDetails
      className="thinking-details"
      summaryClassName="thinking-summary"
      summary={(
        <>
          <span className="thinking-label">thinking</span>
          <span className="thinking-preview">{thinkingPreviewText(text)}</span>
        </>
      )}
      {...(frozen ? {} : { open: !done || userOpened, onOpenChange: setUserOpened })}
    >
      <pre className="thinking-body">{text}</pre>
    </AnimatedDetails>
  )
})