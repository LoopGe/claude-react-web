// Markdown renderer for chat messages.
//
// Uses react-markdown + remark-gfm (tables / task lists / strikethrough)
// + a custom lowlight-based rehype plugin for syntax highlighting.
//
// We deliberately do NOT enable rehype-raw or any HTML-passthrough plugin —
// assistant output is only semi-trusted and we prefer to render raw HTML
// as text rather than risk XSS.

import { memo, useMemo, useState, useRef } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { createLowlight } from 'lowlight'
import { ErrorBoundary } from './ErrorBoundary'
import { rehypeHighlightQuery } from '../search'

// Register only the languages most commonly seen in Claude responses.
// Each language adds ~2-8 KB to the bundle.
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import java from 'highlight.js/lib/languages/java'
import cpp from 'highlight.js/lib/languages/cpp'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import markdown from 'highlight.js/lib/languages/markdown'
import yaml from 'highlight.js/lib/languages/yaml'
import ruby from 'highlight.js/lib/languages/ruby'
import swift from 'highlight.js/lib/languages/swift'
import kotlin from 'highlight.js/lib/languages/kotlin'
import csharp from 'highlight.js/lib/languages/csharp'
import php from 'highlight.js/lib/languages/php'
import htmlLang from 'highlight.js/lib/languages/xml'  // xml covers html
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import makefile from 'highlight.js/lib/languages/makefile'
import ini from 'highlight.js/lib/languages/ini'
import properties from 'highlight.js/lib/languages/properties'

const lowlight = createLowlight({
  javascript, typescript, python, bash, json, xml,
  css, java, cpp, go, rust, sql, markdown, yaml,
  ruby, swift, kotlin, csharp, php, html: htmlLang,
  diff, dockerfile, makefile, ini, properties,
})

lowlight.registerAlias({
  javascript: ['js', 'jsx'],
  typescript: ['ts', 'tsx'],
  python: ['py'],
  bash: ['sh', 'shell', 'zsh'],
  cpp: ['c', 'c++'],
  markdown: ['md'],
  yaml: ['yml'],
  ruby: ['rb'],
  rust: ['rs'],
  csharp: ['cs'],
  ini: ['toml'],
  go: ['protobuf'],  // close enough for proto
})

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

export const Markdown = memo(function Markdown({ text, searchQuery }: { text: string; searchQuery?: string }) {
  // Fall back to a <pre>-rendered raw text if anything inside react-markdown
  // (or our rehype plugins) throws — prevents one bad message from blanking
  // the whole transcript.
  return (
    <ErrorBoundary fallback={<pre className="md md-fallback">{text}</pre>}>
      <MarkdownInner text={text} searchQuery={searchQuery} />
    </ErrorBoundary>
  )
})

const MarkdownInner = memo(function MarkdownInner({ text, searchQuery }: { text: string; searchQuery?: string }) {
  const q = searchQuery?.trim()

  // Build the plugin array once per query change.  The search
  // highlighter (from src/search/) flattens the tree, runs the regex
  // ONCE on the canonical text, then splices <mark>s — so phrases
  // that span inline boundaries (e.g. "**hello** world" → query
  // "hello world") are highlighted, which the previous per-text-node
  // implementation could not reach.
  const rehypePlugins = useMemo(
    () => q ? [rehypeHighlightLite, rehypeHighlightQuery(q)] : [rehypeHighlightLite],
    [q],
  )

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={{
          // Open links in a new tab with rel="noreferrer" to keep them harmless
          a: ({ href, children, ...props }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" {...props}>
              {children}
            </a>
          ),
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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

/** Fenced code block with language label and copy button. */
function CodeBlock({ lang, children, ...props }: { lang?: string } & ComponentPropsWithoutRef<'pre'>) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const preRef = useRef<HTMLPreElement>(null)

  const handleCopy = () => {
    const text = preRef.current?.textContent ?? ''
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
        <button type="button" className="code-block-copy" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre ref={preRef} {...props}>{children}</pre>
    </div>
  )
}
