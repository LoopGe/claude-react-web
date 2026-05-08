// Markdown renderer for chat messages.
//
// Uses react-markdown + remark-gfm (tables / task lists / strikethrough).
// We deliberately do NOT enable rehype-raw or any HTML-passthrough plugin —
// assistant output is only semi-trusted and we prefer to render raw HTML
// as text rather than risk XSS.

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
                <pre>
                  <code className={className} {...props}>
                    {children}
                  </code>
                </pre>
              )
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            )
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
