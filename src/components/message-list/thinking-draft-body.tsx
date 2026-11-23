// Body of the in-place streaming thinking row — see
// docs/superpowers/specs/2026-11-23-streaming-thinking-design.md §5.4.
// PLACEHOLDER (Task 5): frozen half-cards render their partial text statically;
// Task 7 replaces this with the controlled two-state leaf (live streaming
// expanded pre + done-folded AnimatedDetails, pixel-parity with the settled
// thinking block).

import { memo } from 'react'

export const ThinkingDraftBody = memo(function ThinkingDraftBody({ frozenText }: {
  sessionId?: string
  frozenText?: string
}) {
  return <pre className="thinking-body">{frozenText ?? ''}</pre>
})