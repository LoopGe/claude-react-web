// Body of the in-place draft card (inline streaming) — see
// docs/superpowers/specs/2026-10-28-inplace-streaming-card-design.md §5.3.
//
// Every block — prose AND fenced code — compiles through the SAME
// `compileMarkdown` pipeline the settled cards use (including the lowlight
// code highlighting), as BARE blocks inside ONE `.md` root: for the same
// source the DOM is byte-identical to the settled whole-compile output, so
// the settle hand-off swaps renderers without a single pixel changing (the
// pixel-parity contract). Frozen blocks hit the LRU (same tree reference
// every render → React bails); the open tail compiles transient (never
// admitted — its source is unique per flush). The typing cursor is pure CSS
// on the tail's last leaf (chat.css `.draft-body`), so it too leaves no DOM
// trace; a childless body shows the fallback span instead.

import { Fragment, memo, type ReactElement } from 'react'
import { splitStreamBlocks, type StreamSegment } from '../../utils/stream-segments'
import { compileMarkdown } from '../../utils/markdown-cache'
import { useOptionalSessionField } from '../../session-store/selectors'

/** Rebuild a code segment's fenced source so it compiles to exactly the
 *  settled `pre` override's DOM (the pipeline does the language bar,
 *  copy button and highlighting). Mirrors the recovery invariant in
 *  stream-segments.test.ts. */
function fenceSource(seg: Extract<StreamSegment, { type: 'code' }>): string {
  return '```' + (seg.lang ?? '') + '\n' + seg.content + (seg.content ? '\n' : '') + (seg.closed ? '```' : '')
}

/** Bare-block markdown body. */
export function DraftBlocks({ text }: { text: string }): ReactElement {
  const blocks = splitStreamBlocks(text)
  return (
    <div className="md">
      {blocks.map((seg, i) => {
        const tail = i === blocks.length - 1
        const source = seg.type === 'code' ? fenceSource(seg) : seg.content
        return <Fragment key={i}>{compileMarkdown(source, { transient: tail })}</Fragment>
      })}
      {blocks.length === 0 && <span className="streaming-cursor streaming-cursor-fallback" />}
    </div>
  )
}

/** Draft-card body: `frozenText` renders statically (a frozen interrupted
 *  half-card — its text lives on the row, the store is done with it); without
 *  it the body is a live leaf reading `draft.text` from the session store, so
 *  the 80ms flushes re-render this component only — never the row layer.
 *  The subscription is INERT when frozenText is given: a frozen card must
 *  not churn on a later live draft's flushes. */
export const DraftTextBody = memo(function DraftTextBody({ sessionId, frozenText }: {
  sessionId?: string
  frozenText?: string
}) {
  const draft = useOptionalSessionField(frozenText != null ? undefined : sessionId, 'draft')
  const text = frozenText ?? draft?.text ?? ''
  return <DraftBlocks text={text} />
})
