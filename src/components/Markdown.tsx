// Markdown renderer for chat messages.
//
// The pipeline (remark-parse + remark-gfm for tables / task lists /
// strikethrough, remark-rehype, a lowlight-based highlighter, then
// hast-util-to-jsx-runtime) lives in utils/markdown-cache.ts, NOT here: its
// output is memoised in a module LRU so a Virtuoso scroll-out/scroll-back
// remount is a map hit instead of a re-parse. This file is just the
// component shell around `compileMarkdown`.
//
// We deliberately do NOT enable rehype-raw or any HTML-passthrough plugin —
// assistant output is only semi-trusted and we prefer to render raw HTML
// as text rather than risk XSS.

import { memo } from 'react'
import { ErrorBoundary } from './ErrorBoundary'
import { compileMarkdown } from '../utils/markdown-cache'

// Re-export CodeBlock so existing `import { CodeBlock } from './Markdown'`
// sites (e.g. FileViewer.tsx) keep working after the extraction.
export { CodeBlock } from './markdown-components'

export const Markdown = memo(function Markdown({ text, searchQuery, activeMatchIdx, breaks }: { text: string; searchQuery?: string; activeMatchIdx?: number; breaks?: boolean }) {
  // Fall back to a <pre>-rendered raw text if anything inside the unified
  // pipeline (or our rehype plugins) throws — prevents one bad message from
  // blanking the whole transcript.
  return (
    <ErrorBoundary fallback={<pre className="md md-fallback">{text}</pre>}>
      <MarkdownInner text={text} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} breaks={breaks} />
    </ErrorBoundary>
  )
})

const MarkdownInner = memo(function MarkdownInner({ text, searchQuery, activeMatchIdx, breaks }: { text: string; searchQuery?: string; activeMatchIdx?: number; breaks?: boolean }) {
  return (
    <div className="md">
      {compileMarkdown(text, { breaks, searchQuery, activeMatchIdx })}
    </div>
  )
})
