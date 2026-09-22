// Rehype plugin: syntax highlighting for fenced code blocks via lowlight.
//
// Extracted from Markdown.tsx so both the ReactMarkdown path and the
// toJsxRuntime (compileMarkdown) path share the same implementation.
//
// Produces proper hast element nodes (spans with hljs-* classes) instead
// of raw HTML strings, which `hast-util-to-jsx-runtime` can render.
//
// Note: this MUST run before rehypeHighlightQuery so that search marks land
// inside the colourised spans (resulting in nested
// `<span class="hljs-keyword"><mark>function</mark></span>` markup that
// composes both colours visually).  If the order were swapped, the lowlight
// pass would replace the text-with-marks subtree wholesale and erase the
// highlights.

import { lowlight } from '../utils/lowlight-instance'

/** Minimal hast-like node shape. Uses a loose type rather than importing
 *  hast's full union to keep the plugin self-contained. */
export interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: string[]; [k: string]: unknown }
  children?: HastNode[]
}

/** Walk a hast tree, visiting every node. */
export function visitNodes(node: HastNode, fn: (n: HastNode) => void): void {
  fn(node)
  if (node.children) {
    for (const child of node.children) visitNodes(child, fn)
  }
}

/** Extract concatenated text content from a hast node. */
export function extractText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  if (!node.children) return ''
  return node.children.map(extractText).join('')
}

/** Rehype plugin that highlights fenced code blocks using lowlight. */
export function rehypeHighlightLite() {
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
