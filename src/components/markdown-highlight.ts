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

      // Ask lowlight itself whether it knows this tag, rather than catching the
      // throw it raises for an unknown grammar: a fence tagged with something
      // we don't ship (```elixir) is ordinary model output, not an exceptional
      // condition.
      //
      // `lowlight.registered` and NOT `isRegisteredLanguage`: that helper is a
      // hand-maintained Set written for diff-highlight.tsx, whose language
      // comes from `detectLanguage(path)` — a fixed extension table that only
      // ever yields names in the Set. Fence tags are model output, and
      // lowlight's own resolver accepts much more: `register()` also picks up
      // each grammar's built-in `aliases` (so `mjs`, `kt`, `docker`, `patch`,
      // `golang`, `jsonc`, `cc`, … all resolve even though the Set lists none
      // of them), and it lowercases before lookup (so ```Python resolves).
      // Gating on the narrower Set silently dropped highlighting for all of
      // those. `registered` tracks registration and aliasing with no second
      // list to keep in sync.
      if (!lowlight.registered(lang)) return
      try {
        const result = lowlight.highlight(lang, text)
        if (result.children.length > 0) {
          node.children = result.children as HastNode[]
        }
      } catch {
        // Grammar failed on this input — leave the raw text as-is.
      }
    })
  }
}
