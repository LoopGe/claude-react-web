// Markdown renderer for chat messages.
//
// Uses react-markdown + remark-gfm (tables / task lists / strikethrough)
// + a lightweight rehype-highlight plugin that registers only common
// languages from highlight.js/lib/core instead of pulling the full
// ~9.3 MB highlight.js bundle. This cuts ~200 KB off the client bundle.
//
// We deliberately do NOT enable rehype-raw or any HTML-passthrough plugin —
// assistant output is only semi-trusted and we prefer to render raw HTML
// as text rather than risk XSS.

import { memo, useState, useRef } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/core'

// Register only the languages most commonly seen in Claude responses.
// highlight.js/lib/core starts empty — each language adds ~2-8 KB.
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
import html from 'highlight.js/lib/languages/xml'  // xml covers html
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import makefile from 'highlight.js/lib/languages/makefile'
import ini from 'highlight.js/lib/languages/ini'
import properties from 'highlight.js/lib/languages/properties'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('jsx', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('tsx', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('zsh', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', html)
hljs.registerLanguage('css', css)
hljs.registerLanguage('java', java)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('c', cpp)
hljs.registerLanguage('c++', cpp)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('rs', rust)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('rb', ruby)
hljs.registerLanguage('swift', swift)
hljs.registerLanguage('kotlin', kotlin)
hljs.registerLanguage('kt', kotlin)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('cs', csharp)
hljs.registerLanguage('php', php)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('makefile', makefile)
hljs.registerLanguage('ini', ini)
hljs.registerLanguage('properties', properties)
hljs.registerLanguage('toml', ini)
hljs.registerLanguage('protobuf', go)  // close enough for proto

/** Minimal rehype plugin that highlights fenced code blocks using the
 *  pre-registered highlight.js core. Replaces rehype-highlight which
 *  bundles ALL languages (~9.3 MB). */
function rehypeHighlightLite() {
  return (tree: unknown) => {
    visitNodes(tree as unknown as HastNode, (node) => {
      if (
        node.type === 'element' &&
        node.tagName === 'code' &&
        node.properties &&
        Array.isArray(node.properties.className)
      ) {
        const classes = node.properties.className as string[]
        const langClass = classes.find((c) => c.startsWith('language-'))
        if (!langClass) return
        const lang = langClass.slice('language-'.length)
        // Extract raw text from the code node's children
        const text = extractText(node)
        if (!text) return
        try {
          const result = lang
            ? hljs.highlight(text, { language: lang, ignoreIllegals: true })
            : hljs.highlightAuto(text)
          // Replace children with highlighted HTML
          node.children = [{ type: 'raw', value: result.value }]
          // Ensure the language class is present for the CSS theme
          if (!classes.includes(langClass)) classes.push(langClass)
        } catch {
          // Language not registered — leave the raw text as-is
        }
      }
    })
  }
}

/** Minimal hast-like node shape used by the highlight walker. We use a
 *  loose type rather than importing hast's full union to keep the plugin
 *  self-contained and avoid casting gymnastics. */
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

// Memoize so that <Markdown text={sameString} /> doesn't re-parse
// on parent re-renders (e.g. when the messages array is rebuilt during
// session switch). MessageView is already memo'd on the full msg object,
// but the msg identity changes during replay flush even when content is
// identical — this memo catches that case.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlightLite]}
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
              // Block code: rehype-highlight has already transformed the
              // children into <span class="hljs-*"> elements. We let the
              // `pre` override below handle the outer wrapper (language
              // label + copy button). The code override only needs to
              // pass through the highlighted children.
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
