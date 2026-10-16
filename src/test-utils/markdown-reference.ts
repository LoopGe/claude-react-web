// Test-only REFERENCE for the on-demand grammars: the markdown pipeline as it
// was before the non-core highlight.js grammars became lazy — every grammar
// registered up front (same order, same aliases). The parity tests compare
// the real, lazily loading pipeline against this, so "after the loads, the
// output is byte-identical to the eager build" is checked, not assumed.
//
// Keep it frozen: it describes the old behaviour, so it must NOT import
// lowlight-instance.ts, markdown-cache.ts or markdown-highlight.ts.

import { Fragment, type ReactNode } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import { toJsxRuntime, type Options as ToJsxOptions } from 'hast-util-to-jsx-runtime'
import { createLowlight } from 'lowlight'
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
import markdownLang from 'highlight.js/lib/languages/markdown'
import yaml from 'highlight.js/lib/languages/yaml'
import ruby from 'highlight.js/lib/languages/ruby'
import swift from 'highlight.js/lib/languages/swift'
import kotlin from 'highlight.js/lib/languages/kotlin'
import csharp from 'highlight.js/lib/languages/csharp'
import php from 'highlight.js/lib/languages/php'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import makefile from 'highlight.js/lib/languages/makefile'
import ini from 'highlight.js/lib/languages/ini'
import properties from 'highlight.js/lib/languages/properties'
import { rehypeStripStructuralWhitespace } from '../../shared/search/rehype-strip-structural-whitespace'
import { htmlAsTextHandlers } from '../../shared/markdown-html-text'
import { rehypeHighlightQuery } from '../search'
import { MD_COMPONENTS } from '../components/markdown-components'

/** The 24 grammars, registered in the old object order (html after php). */
export const REFERENCE_GRAMMARS = {
  javascript, typescript, python, bash, json, xml, css, java, cpp, go, rust, sql,
  markdown: markdownLang, yaml, ruby, swift, kotlin, csharp, php, diff, dockerfile,
  makefile, ini, properties,
} as const

/** Our aliases as the old lowlight-instance.ts registered them. */
export const REFERENCE_CUSTOM_ALIASES: Readonly<Record<string, readonly string[]>> = {
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
  go: ['protobuf'],
}

export const referenceLowlight = createLowlight({
  javascript, typescript, python, bash, json, xml, css, java, cpp, go, rust, sql,
  markdown: markdownLang, yaml, ruby, swift, kotlin, csharp, php,
  html: xml,
  diff, dockerfile, makefile, ini, properties,
})
referenceLowlight.registerAlias(REFERENCE_CUSTOM_ALIASES)

interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: string[]; [k: string]: unknown }
  children?: Node[]
}

function visit(node: Node, fn: (n: Node) => void): void {
  fn(node)
  if (node.children) for (const child of node.children) visit(child, fn)
}

function text(node: Node): string {
  if (node.type === 'text') return node.value ?? ''
  return node.children ? node.children.map(text).join('') : ''
}

/** The old rehypeHighlightLite, on the eager reference instance. */
function referenceHighlight() {
  return (tree: unknown) => {
    visit(tree as Node, (node) => {
      if (node.type !== 'element' || node.tagName !== 'code' || !node.properties || !Array.isArray(node.properties.className)) return
      const langClass = node.properties.className.find((c) => c.startsWith('language-'))
      if (!langClass) return
      const lang = langClass.slice('language-'.length)
      const value = text(node)
      if (!value) return
      if (!referenceLowlight.registered(lang)) return
      try {
        const result = referenceLowlight.highlight(lang, value)
        if (result.children.length > 0) node.children = result.children as Node[]
      } catch {
        // as the old plugin: leave the raw text
      }
    })
  }
}

const KATEX_OPTIONS = { strict: false, errorColor: 'var(--danger-text)' } as const

export interface ReferenceOptions {
  breaks?: boolean
  searchQuery?: string
  activeMatchIdx?: number
}

/** Compile like the old compileMarkdown (minus its cache). */
export function referenceCompile(source: string, opts: ReferenceOptions = {}): ReactNode {
  const q = opts.searchQuery?.trim()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let p: any = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
  if (opts.breaks) p = p.use(remarkBreaks)
  p = p.use(remarkRehype, { handlers: htmlAsTextHandlers }).use(rehypeStripStructuralWhitespace)
  if (q) {
    p = p.use(referenceHighlight).use(() => rehypeHighlightQuery(q, opts.activeMatchIdx)).use(rehypeKatex, KATEX_OPTIONS)
  } else {
    p = p.use(rehypeKatex, KATEX_OPTIONS).use(referenceHighlight)
  }
  const hast = p.runSync(p.parse(source))
  return toJsxRuntime(hast as never, {
    Fragment,
    jsx,
    jsxs,
    components: MD_COMPONENTS as ToJsxOptions['components'],
    elementAttributeNameCase: 'react',
    stylePropertyNameCase: 'css',
  })
}
