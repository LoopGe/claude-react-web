// Markdown renderer for chat messages.
//
// Uses react-markdown + remark-gfm (tables / task lists / strikethrough)
// + rehype-highlight for syntax highlighting in fenced code blocks.
// We deliberately do NOT enable rehype-raw or any HTML-passthrough plugin —
// assistant output is only semi-trusted and we prefer to render raw HTML
// as text rather than risk XSS.

import { useState, useRef } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
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
}

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
