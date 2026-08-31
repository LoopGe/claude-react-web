// Markdown renderer for chat messages.
//
// Uses react-markdown + remark-gfm (tables / task lists / strikethrough)
// + a custom lowlight-based rehype plugin for syntax highlighting.
//
// We deliberately do NOT enable rehype-raw or any HTML-passthrough plugin —
// assistant output is only semi-trusted and we prefer to render raw HTML
// as text rather than risk XSS.

import { memo, useMemo, useState, useRef } from 'react'
import type { ComponentPropsWithoutRef, Ref } from 'react'
import { useMergedRef } from '../utils/mergedRef'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { ErrorBoundary } from './ErrorBoundary'
import { rehypeHighlightQuery } from '../search'
import { lowlight } from '../utils/lowlight-instance'
import { rehypeStripStructuralWhitespace } from '../../shared/search/rehype-strip-structural-whitespace'

/** Minimal hast-like node shape. Uses a loose type rather than importing
 *  hast's full union to keep the plugin self-contained. */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: string[]; [k: string]: unknown }
  children?: HastNode[]
}

/** Walk a hast tree, visiting every node. */
function visitNodes(node: HastNode, fn: (n: HastNode) => void): void {
  fn(node)
  if (node.children) {
    for (const child of node.children) visitNodes(child, fn)
  }
}

/** Extract concatenated text content from a hast node. */
function extractText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  if (!node.children) return ''
  return node.children.map(extractText).join('')
}

/** Rehype plugin that highlights fenced code blocks using lowlight.
 *  Produces proper hast element nodes (spans with hljs-* classes) instead
 *  of raw HTML strings, which `hast-util-to-jsx-runtime` can render.
 *
 *  Note: this MUST run before rehypeHighlightQuery so that search
 *  marks land inside the colourised spans (resulting in nested
 *  `<span class="hljs-keyword"><mark>function</mark></span>` markup
 *  that composes both colours visually).  If the order were swapped,
 *  the lowlight pass would replace the text-with-marks subtree
 *  wholesale and erase the highlights. */
function rehypeHighlightLite() {
  return (tree: unknown) => {
    visitNodes(tree as HastNode, (node) => {
      if (
        node.type !== 'element' ||
        node.tagName !== 'code' ||
        !node.properties ||
        !Array.isArray(node.properties.className)
      ) return

      const classes = node.properties.className
      const langClass = classes.find((c) => c.startsWith('language-'))
      if (!langClass) return
      const lang = langClass.slice('language-'.length)
      const text = extractText(node)
      if (!text) return

      try {
        const result = lang
          ? lowlight.highlight(lang, text)
          : lowlight.highlightAuto(text)
        if (result.children.length > 0) {
          node.children = result.children as HastNode[]
        }
      } catch {
        // Language not registered — leave the raw text as-is
      }
    })
  }
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

/** URL transform for markdown links/images.
 *
 * react-markdown's defaultUrlTransform strips `data:` URLs entirely (to keep
 * `javascript:` etc. out of href/src), which blanked embedded base64 images in
 * assistant replies. We let image `src` pass through UNCHANGED so the `img`
 * override below can decide: it only ever puts `data:image/*` or http(s) into a
 * real `src` — anything else renders as inert fallback text. Every other URL
 * attribute (`href`, …) keeps delegating to defaultUrlTransform, so link
 * sanitisation is byte-identical to today.
 *
 * react-markdown applies this to `img`'s `src` (html-url-attributes lists src
 * for img) before the component renderer sees it — verified against the
 * installed 9.1.0 source. */
function mdUrlTransform(url: string, key: string): string {
  if (key === 'src') return url
  return defaultUrlTransform(url)
}

const MD_COMPONENTS: Components = {
  a: ({ href, children, ...props }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" {...props}>
      {children}
    </a>
  ),
  // Renders markdown image references defensively. `src` has already been
  // through mdUrlTransform (unchanged), so this sees the raw URL. Only
  // data:image/* and http(s) become a real <img>; anything else (e.g. the
  // model's `/api/placeholder`) renders as muted fallback text instead of a
  // broken image. No `{...props}` spread: react-markdown passes a `node` prop
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

export const Markdown = memo(function Markdown({ text, searchQuery, activeMatchIdx, breaks }: { text: string; searchQuery?: string; activeMatchIdx?: number; breaks?: boolean }) {
  // Fall back to a <pre>-rendered raw text if anything inside react-markdown
  // (or our rehype plugins) throws — prevents one bad message from blanking
  // the whole transcript.
  return (
    <ErrorBoundary fallback={<pre className="md md-fallback">{text}</pre>}>
      <MarkdownInner text={text} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} breaks={breaks} />
    </ErrorBoundary>
  )
})

const MarkdownInner = memo(function MarkdownInner({ text, searchQuery, activeMatchIdx, breaks }: { text: string; searchQuery?: string; activeMatchIdx?: number; breaks?: boolean }) {
  const q = searchQuery?.trim()

  // Build the plugin array once per query change.  The search
  // highlighter (from src/search/) flattens the tree, runs the regex
  // ONCE on the canonical text, then splices <mark>s — so phrases
  // that span inline boundaries (e.g. "**hello** world" → query
  // "hello world") are highlighted, which the previous per-text-node
  // implementation could not reach.
  //
  // Important: `rehypeHighlightQuery(q)` already returns the transformer
  // `(tree) => void`, NOT an attacher. unified expects each entry in
  // `rehypePlugins` to be an attacher (a function it calls *with no
  // tree*, expecting a transformer back). Passing the transformer
  // directly makes unified call it as `transformer()`, which threw
  // inside walkSearchable and was silently swallowed by <ErrorBoundary>
  // — the UI rendered fine but no <mark>s ever appeared. We wrap it in
  // a one-line attacher so unified gets the shape it expects.
  //
  // `activeMatchIdx` (when set) tells the highlighter which of the
  // matches inside THIS markdown source is the user's current
  // navigation target. The caller is expected to map "global active
  // hit" → "local match index inside this block" before passing it
  // here. Undefined / out-of-range silently means "no active mark".
  // `rehypeStripStructuralWhitespace` runs FIRST so the highlighter sees the
  // same tree ingest does (see extract.ts) — keeps search offsets aligned. It
  // removes the inter-block `\n` and post-`<br>` `\n` text nodes that
  // `white-space: pre-wrap` would otherwise render as extra blank lines.
  const rehypePlugins = useMemo(
    () => q ? [rehypeStripStructuralWhitespace, rehypeHighlightLite, () => rehypeHighlightQuery(q, activeMatchIdx)] : [rehypeStripStructuralWhitespace, rehypeHighlightLite],
    [q, activeMatchIdx],
  )

  // `breaks` turns single newlines into <br> (via remark-breaks) instead of
  // the CommonMark default — which collapses a soft break to a space. Used for
  // human user messages, where a Shift+Enter newline should stay a newline in
  // the rendered bubble. Assistant output keeps the default so its Markdown
  // paragraph spacing is unchanged. The array identity is memoised on `breaks`
  // so react-markdown's internal plugin cache stays effective across renders.
  const remarkPlugins = useMemo(
    () => (breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]),
    [breaks],
  )

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={MD_COMPONENTS}
        urlTransform={mdUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

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
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const innerRef = useRef<HTMLPreElement>(null)
  // External consumers (e.g. FileViewer's useOverlayScrollbar) need the
  // scrollable <pre> element. useMergedRef keeps the copy path's ref intact
  // while also handing the node out to the caller.
  const preRefMerged = useMergedRef(innerRef, preRef)

  const handleCopy = () => {
    const text = innerRef.current?.textContent ?? ''
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopied(false), 2000)
      },
      (err: unknown) => { console.warn('clipboard write failed:', err) },
    )
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
