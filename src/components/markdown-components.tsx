// Shared markdown component overrides and helpers.
//
// Extracted from Markdown.tsx so both the ReactMarkdown path and the
// toJsxRuntime (compileMarkdown) path share the same implementation.
// CodeBlock, sanitizeHref, and the MD_COMPONENTS map all live here.

import { memo, useRef } from 'react'
import type { ComponentPropsWithoutRef, Ref } from 'react'
import { defaultUrlTransform, type Components } from 'react-markdown'
import { useMergedRef } from '../utils/mergedRef'
import { useCopy } from '../hooks/useCopy'

/** Sanitize an href for the `a` component.
 *
 * `compileMarkdown` renders through `toJsxRuntime`, which has no
 * `urlTransform` hook of its own — so this function is the ONLY href gate on
 * the render path, and it has to be as strict as the one react-markdown
 * applied before the migration. Delegating to react-markdown's
 * `defaultUrlTransform` is what keeps it byte-identical: it strips
 * `javascript:`, `vbscript:`, `data:` and `file:` alike. The hand-rolled
 * scheme test this replaced only covered `javascript:` / `vbscript:`, which
 * let `data:text/html,<script>…</script>` through. */
export function sanitizeHref(url: string): string {
  return defaultUrlTransform(url)
}

/** Module-level react-markdown `components` map.
 *
 * Hoisted out of MarkdownInner so the object identity is stable across
 * renders. A fresh inline `{{ a: …, code: …, pre: … }}` literal on every
 * render handed react-markdown a new `components` prop, which defeated its
 * internal memoization and re-rendered every element on each render (e.g.
 * every keystroke during in-message search). The renderers below read
 * everything from props/children, so they have no per-render closure
 * dependency and are safe to share. See Perf M3 in the audit.
 *
 * Headings are remapped so the largest in-message heading is <h3>. The app
 * shell reserves <h1> (main region) and <h2> (empty state / panel headers),
 * so an assistant `# Foo` would otherwise inject an <h1> mid-document and
 * break the heading outline for screen-reader navigation. See A11y M4. */
export const MD_COMPONENTS: Components = {
  a: ({ href, children, ...props }) => (
    <a href={sanitizeHref(href ?? '')} target="_blank" rel="noreferrer noopener" {...props}>
      {children}
    </a>
  ),
  // Renders markdown image references defensively. `src` arrives RAW from the
  // hast tree (toJsxRuntime applies no urlTransform), so this component is the
  // sole gate: only data:image/* and http(s) become a real <img>. Anything else
  // (e.g. the model's `/api/placeholder`) renders as muted fallback text
  // instead of a broken image. Note this is deliberately NOT sanitizeHref —
  // defaultUrlTransform strips `data:` wholesale, which would blank the
  // embedded base64 images assistants legitimately emit.
  // No `{...props}` spread: react-markdown passes a `node` prop
  // (passNode: true) that must not leak onto the DOM element.
  img: ({ src, alt, title }: { src?: string; alt?: string; title?: string }) => {
    const s = typeof src === 'string' ? src : ''
    if (s.startsWith('data:image/') || /^https?:\/\//i.test(s)) {
      return <img className="msg-image" src={s} alt={alt ?? ''} title={title} loading="lazy" decoding="async" />
    }
    return <span className="md-image-fallback" title={title}>[image{alt ? `: ${alt}` : ''} — {s}]</span>
  },
  // Distinguish inline code from fenced blocks. react-markdown passes
  // an `inline` prop in v9 only through the `code` children prop layout,
  // so we detect block-ness by presence of `\n` or of the `language-*`
  // className that remark applies to fenced blocks.
  code: ({ className, children, ...props }) => {
    const content = String(children ?? '')
    const isBlock = (className && /language-/.test(className)) || content.includes('\n')
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  },
  // Block-level code container: adds a language label (top-right)
  // and a copy-to-clipboard button (appears on hover).
  pre: ({ children, ...props }: ComponentPropsWithoutRef<'pre'>) => {
    // Extract the language from the inner <code> element's className.
    const codeEl = children as { props?: { className?: string } } | undefined
    const langMatch = codeEl?.props?.className?.match(/language-(\S+)/)
    const lang = langMatch?.[1]
    return (
      <CodeBlock lang={lang} {...props}>
        {children}
      </CodeBlock>
    )
  },
  // Remap headings so model output can't break the page outline.
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h4>{children}</h4>,
  h4: ({ children }) => <h5>{children}</h5>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
}

/** Fenced code block with language label and copy button. Memoized so a
 *  parent MarkdownInner re-render (e.g. search-query change that doesn't
 *  touch this block's props) doesn't re-render every code block in the
 *  message. */
export const CodeBlock = memo(function CodeBlock({
  lang,
  children,
  showCopy = true,
  preRef,
  ...props
}: { lang?: string; showCopy?: boolean; preRef?: Ref<HTMLPreElement> } & ComponentPropsWithoutRef<'pre'>) {
  const { copied, copy } = useCopy()
  const innerRef = useRef<HTMLPreElement>(null)
  // External consumers (e.g. FileViewer's useOverlayScrollbar) need the
  // scrollable <pre> element. useMergedRef keeps the copy path's ref intact
  // while also handing the node out to the caller.
  const preRefMerged = useMergedRef(innerRef, preRef)

  // Read the rendered text lazily on click — the block body is already in
  // the DOM, so there is nothing to serialise up front.
  const handleCopy = () => {
    void copy(() => innerRef.current?.textContent ?? '')
  }

  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-block-lang">{lang ?? 'code'}</span>
        {showCopy && (
          <button type="button" className="code-block-copy" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        )}
      </div>
      <pre ref={preRefMerged} {...props}>{children}</pre>
    </div>
  )
})
