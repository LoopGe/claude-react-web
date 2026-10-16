// Shared lowlight instance with all the languages this app cares about.
//
// Markdown.tsx and the diff-line highlighter both need to call
// `lowlight.highlight(lang, text)`; they used to live in separate
// instances which meant double-registration overhead and easy drift.
// One source of truth lives here.
//
// Eager core, the rest on demand. The 24 grammars were ~200 KB pre-minify of
// the eager markdown-vendor chunk, while a transcript usually highlights a
// handful of languages. CORE stays static; the other 16 load the first time a
// fence (or a diff's file) uses them, one chunk each (vite.config.ts).
//
// The core is not just "the common ones": it must be CLOSED under embedded
// sub-languages. A grammar highlights an embedded language (JSX -> xml,
// css`…` -> css, <script> -> javascript, <style> -> css) only when that
// language is registered and silently emits plain text otherwise, so a core
// grammar whose sub-language loaded later would render differently before and
// after. javascript/typescript embed xml + css, and xml embeds css +
// javascript, so all four are core (plus json, bash, python, diff). The lazy
// grammars embed only core languages (markdown -> xml, dockerfile -> bash),
// except yaml, which embeds ruby (ERB) and so loads it first (`deps`).
//
// A lazy grammar is registered only after it AND its deps have loaded, so
// `lowlight.registered(lang)` keeps meaning "highlight() now gives the final
// output", which is what both callers already test. For a tag that is not
// registered YET, `lazyGrammarFor(lang)` names the grammar to request; the
// caller renders plain text meanwhile, keeps that render out of its cache,
// and re-renders on the version bump (markdown-features.ts).
//
// New languages: add the import (core) or a LAZY_GRAMMARS entry, AND any
// aliases below so `detectLanguage()` results land in the right grammar.
// lowlight-instance.test.ts pins the full name -> grammar resolution against
// an eagerly registered reference.

import { createLowlight } from 'lowlight'
import type { LanguageFn } from 'highlight.js'

import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import { notifyMarkdownFeaturesChanged } from './markdown-features'

export const lowlight = createLowlight({
  javascript,
  typescript,
  python,
  bash,
  json,
  xml,
  css,
  html: xml, // xml grammar covers html
  diff,
})

/** Our aliases on top of each grammar's own. Applied again after every lazy
 *  registration, so they still win over grammar-declared aliases exactly as
 *  when everything registered up front (an alias may name a grammar that has
 *  not loaded yet: hljs then resolves it to nothing until it does). */
const CUSTOM_ALIASES: Readonly<Record<string, readonly string[]>> = {
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
  go: ['protobuf'], // close enough for proto highlighting
}

lowlight.registerAlias(CUSTOM_ALIASES)

export type LazyGrammar =
  | 'java' | 'cpp' | 'go' | 'rust' | 'sql' | 'markdown' | 'yaml' | 'ruby'
  | 'swift' | 'kotlin' | 'csharp' | 'php' | 'dockerfile' | 'makefile' | 'ini' | 'properties'

interface LazyGrammarSpec {
  /** One dynamic import per grammar (each becomes its own chunk). */
  load: () => Promise<{ default: LanguageFn }>
  /** Every tag that resolves to this grammar once it is registered: its name,
   *  the grammar's own `aliases`, and ours from CUSTOM_ALIASES, lowercase
   *  (hljs lowercases a tag before lookup). */
  names: readonly string[]
  /** Lazy grammars it embeds; registered before it. */
  deps?: readonly LazyGrammar[]
}

export const LAZY_GRAMMARS: Readonly<Record<LazyGrammar, LazyGrammarSpec>> = {
  java: { load: () => import('highlight.js/lib/languages/java'), names: ['java', 'jsp'] },
  cpp: {
    load: () => import('highlight.js/lib/languages/cpp'),
    names: ['cpp', 'cc', 'c++', 'h++', 'hpp', 'hh', 'hxx', 'cxx', 'c'],
  },
  go: { load: () => import('highlight.js/lib/languages/go'), names: ['go', 'golang', 'protobuf'] },
  rust: { load: () => import('highlight.js/lib/languages/rust'), names: ['rust', 'rs'] },
  sql: { load: () => import('highlight.js/lib/languages/sql'), names: ['sql'] },
  markdown: { load: () => import('highlight.js/lib/languages/markdown'), names: ['markdown', 'md', 'mkdown', 'mkd'] },
  yaml: { load: () => import('highlight.js/lib/languages/yaml'), names: ['yaml', 'yml'], deps: ['ruby'] },
  ruby: {
    load: () => import('highlight.js/lib/languages/ruby'),
    names: ['ruby', 'rb', 'gemspec', 'podspec', 'thor', 'irb'],
  },
  swift: { load: () => import('highlight.js/lib/languages/swift'), names: ['swift'] },
  kotlin: { load: () => import('highlight.js/lib/languages/kotlin'), names: ['kotlin', 'kt', 'kts'] },
  csharp: { load: () => import('highlight.js/lib/languages/csharp'), names: ['csharp', 'cs', 'c#'] },
  php: { load: () => import('highlight.js/lib/languages/php'), names: ['php'] },
  dockerfile: { load: () => import('highlight.js/lib/languages/dockerfile'), names: ['dockerfile', 'docker'] },
  makefile: { load: () => import('highlight.js/lib/languages/makefile'), names: ['makefile', 'mk', 'mak', 'make'] },
  ini: { load: () => import('highlight.js/lib/languages/ini'), names: ['ini', 'toml'] },
  properties: { load: () => import('highlight.js/lib/languages/properties'), names: ['properties'] },
}

const LAZY_BY_NAME = new Map<string, LazyGrammar>()
for (const [id, spec] of Object.entries(LAZY_GRAMMARS) as [LazyGrammar, LazyGrammarSpec][]) {
  for (const name of spec.names) LAZY_BY_NAME.set(name, id)
}

/** The on-demand grammar a tag will resolve to once loaded; undefined when the
 *  tag is registered already, or is not a language this app highlights. */
export function lazyGrammarFor(lang: string): LazyGrammar | undefined {
  if (lowlight.registered(lang)) return undefined
  return LAZY_BY_NAME.get(lang.toLowerCase())
}

const LAZY_GRAMMAR_COUNT = Object.keys(LAZY_GRAMMARS).length
const registeredLazy = new Set<LazyGrammar>()
const inFlight = new Map<LazyGrammar, Promise<void>>()

/** True once every on-demand grammar is registered (nothing left to load). */
export function allGrammarsRegistered(): boolean {
  return registeredLazy.size === LAZY_GRAMMAR_COUNT
}

/**
 * Load and register a lazy grammar (its deps first). Idempotent. Resolves once
 * it is registered, or once the load failed: the tag then stays plain, and the
 * next request retries. Safe to call during render (it only starts a fetch).
 */
export function requestGrammar(id: LazyGrammar): Promise<void> {
  if (registeredLazy.has(id)) return Promise.resolve()
  let load = inFlight.get(id)
  if (!load) {
    const spec = LAZY_GRAMMARS[id]
    const deps = spec.deps ?? []
    load = Promise.all([spec.load(), ...deps.map(requestGrammar)])
      .then(([mod]) => {
        // A dep that failed resolved without registering: registering this
        // grammar now would highlight its embedded language as plain text.
        if (!deps.every((dep) => registeredLazy.has(dep))) throw new Error(`a dependency of ${id} failed to load`)
        lowlight.register(id, mod.default)
        lowlight.registerAlias(CUSTOM_ALIASES)
        registeredLazy.add(id)
        inFlight.delete(id)
        notifyMarkdownFeaturesChanged()
      })
      .catch((err: unknown) => {
        inFlight.delete(id)
        console.warn(`[markdown] highlight grammar "${id}" failed to load; its code stays plain until the next attempt`, err)
      })
    inFlight.set(id, load)
  }
  return load
}

/** Set of languages registered above (plus their aliases). Use this to
 *  guard `lowlight.highlight()` calls — passing an unknown language to
 *  lowlight throws, which we don't want inside React render. Covers lazy
 *  grammars too: check `lazyGrammarFor` before highlighting with one. */
const REGISTERED = new Set<string>([
  'javascript', 'js', 'jsx',
  'typescript', 'ts', 'tsx',
  'python', 'py',
  'bash', 'sh', 'shell', 'zsh',
  'json',
  'xml', 'html',
  'css',
  'java',
  'cpp', 'c', 'c++',
  'go', 'protobuf',
  'rust', 'rs',
  'sql',
  'markdown', 'md',
  'yaml', 'yml',
  'ruby', 'rb',
  'swift',
  'kotlin',
  'csharp', 'cs',
  'php',
  'diff',
  'dockerfile',
  'makefile',
  'ini', 'toml',
  'properties',
])

export function isRegisteredLanguage(lang: string | null | undefined): boolean {
  return lang != null && REGISTERED.has(lang)
}
