// The lazy grammar split must not change WHAT gets highlighted or HOW: every
// tag the old eager instance resolved still resolves (now or after a load),
// to the same grammar, with byte-identical output once loaded. The old
// instance is rebuilt in src/test-utils/markdown-reference.ts.

import { describe, it, expect } from 'vitest'
import hljs from 'highlight.js/lib/core'
import type { LanguageFn, Mode } from 'highlight.js'
import { lowlight, lazyGrammarFor, requestGrammar, allGrammarsRegistered, LAZY_GRAMMARS, type LazyGrammar } from './lowlight-instance'
import { REFERENCE_CUSTOM_ALIASES, REFERENCE_GRAMMARS, referenceLowlight } from '../test-utils/markdown-reference'

type GrammarId = keyof typeof REFERENCE_GRAMMARS
const GRAMMAR_IDS = Object.keys(REFERENCE_GRAMMARS) as GrammarId[]
const LAZY_IDS = Object.keys(LAZY_GRAMMARS) as LazyGrammar[]
const CORE_IDS = GRAMMAR_IDS.filter((id) => !(LAZY_IDS as string[]).includes(id))

/** Old registration order: the createLowlight object (html after php). */
const OLD_ORDER = [
  'javascript', 'typescript', 'python', 'bash', 'json', 'xml', 'css', 'java', 'cpp', 'go', 'rust', 'sql',
  'markdown', 'yaml', 'ruby', 'swift', 'kotlin', 'csharp', 'php', 'html', 'diff', 'dockerfile', 'makefile',
  'ini', 'properties',
] as const

function grammarOf(name: (typeof OLD_ORDER)[number]): GrammarId {
  return name === 'html' ? 'xml' : name
}

function ownAliases(id: GrammarId): string[] {
  return ((REFERENCE_GRAMMARS[id] as LanguageFn)(hljs).aliases ?? []).map((a) => a.toLowerCase())
}

/** Every tag the old instance resolved, mapped to the grammar it resolved to.
 *  Replays hljs's own rule: language names first, then the alias map, where a
 *  later registration overwrites an alias and our aliases were applied last. */
function oldResolution(): Map<string, GrammarId> {
  const languages = new Map<string, GrammarId>()
  const aliases = new Map<string, string>()
  for (const name of OLD_ORDER) {
    languages.set(name, grammarOf(name))
    for (const alias of ownAliases(grammarOf(name))) aliases.set(alias, name)
  }
  for (const [name, list] of Object.entries(REFERENCE_CUSTOM_ALIASES)) for (const alias of list) aliases.set(alias, name)
  const out = new Map<string, GrammarId>(languages)
  for (const [alias, name] of aliases) if (!out.has(alias)) out.set(alias, languages.get(name)!)
  return out
}

const OLD = oldResolution()
const NOT_OURS = [
  'haskell', 'mermaid', 'elixir', 'plaintext', 'text', 'txt', 'math', 'latex', 'tex', 'graphql', 'handlebars',
  'scss', 'less', 'console', 'shell-session', 'objectivec', 'vue', 'svelte', 'lua', 'perl', 'r', 'scala', 'dart',
  'zig', 'powershell', 'ps1', 'bat', 'cmd', 'not-a-real-language', 'c-like', 'json5', '', ' ',
]
/** Every tag worth asking about: all old names, case variants, and a spread of
 *  hljs languages the app never registered. */
const CANDIDATES = [...new Set([
  ...OLD.keys(),
  ...[...OLD.keys()].map((n) => n.toUpperCase()),
  ...[...OLD.keys()].map((n) => n.charAt(0).toUpperCase() + n.slice(1)),
  ...NOT_OURS,
])]

/** Sub-languages a grammar embeds (walks its mode tree). */
function subLanguages(id: GrammarId): string[] {
  const out = new Set<string>()
  const seen = new Set<unknown>()
  const walk = (mode: Mode | undefined): void => {
    if (!mode || typeof mode !== 'object' || seen.has(mode)) return
    seen.add(mode)
    if (mode.subLanguage) for (const s of ([] as string[]).concat(mode.subLanguage)) out.add(s)
    for (const child of mode.contains ?? []) if (typeof child === 'object') walk(child as Mode)
    for (const variant of mode.variants ?? []) walk(variant)
    walk(mode.starts)
  }
  walk((REFERENCE_GRAMMARS[id] as LanguageFn)(hljs) as unknown as Mode)
  return [...out]
}

/** One snippet per grammar, chosen to exercise its embedded languages. */
const SAMPLES: Record<GrammarId, string> = {
  javascript: 'const el = <div className="x">{a}</div>\nconst s = css`color: red;`\nfunction f(a) { return a ?? 1 }',
  typescript: 'interface U { id: number }\nexport const greet = (u: U): string => `hi ${u.id}`\nconst v = <Box sx={{ p: 1 }} />',
  python: 'def fib(n: int) -> int:\n    return n if n < 2 else fib(n - 1)',
  bash: 'for f in *.log; do echo "$f"; done | sort -u',
  json: '{ "name": "demo", "version": "1.0.0", "private": true }',
  xml: '<div class="card"><style>.a { color: red }</style><script>let x = 1</script></div>',
  css: '.card { color: var(--fg); border-radius: 8px; }',
  java: 'public class Hi { public static void main(String[] a) { System.out.println("hi"); } }',
  cpp: '#include <vector>\nint main() { std::vector<int> v{1,2,3}; return v.size(); }',
  go: 'func Add(a, b int) int { return a + b }',
  rust: 'fn main() { let v: Vec<i32> = (1..=3).collect(); println!("{:?}", v); }',
  sql: 'SELECT id, name FROM users WHERE active = 1 ORDER BY name;',
  markdown: '# Title\n- item with <b>html</b>\n\n```js\nx\n```',
  yaml: 'services:\n  web:\n    image: <%= image %>\n    ports: ["8080:80"]',
  ruby: 'puts [1, 2, 3].map { |x| x * 2 }.inspect',
  swift: 'let xs = [1, 2, 3].map { $0 * 2 }',
  kotlin: 'fun main() { println(listOf(1, 2, 3).map { it * 2 }) }',
  csharp: 'var xs = new[] { 1, 2, 3 }.Select(x => x * 2);',
  php: '<?php echo array_sum([1, 2, 3]); ?>',
  diff: '- const old = 1\n+ const next = 2',
  dockerfile: 'FROM node:20-alpine\nRUN npm ci --omit=dev && echo "$HOME"',
  makefile: 'build:\n\tgo build ./...',
  ini: '[package]\nname = "demo"',
  properties: 'server.port=8080',
}

describe('lowlight-instance: lazy grammar split', () => {
  it('registers exactly the core grammars up front', () => {
    expect(CORE_IDS.sort()).toEqual(['bash', 'css', 'diff', 'javascript', 'json', 'python', 'typescript', 'xml'])
    for (const id of GRAMMAR_IDS) expect(lowlight.registered(id), id).toBe(CORE_IDS.includes(id))
    expect(lowlight.registered('html')).toBe(true)
  })

  it('keeps the core closed under embedded languages, and every lazy grammar loads what it embeds', () => {
    const ours = new Set<string>(GRAMMAR_IDS)
    for (const id of GRAMMAR_IDS) {
      const embedded = subLanguages(id).filter((s) => ours.has(s) && s !== id)
      const allowed = new Set<string>([...CORE_IDS, ...((LAZY_GRAMMARS as Record<string, { deps?: readonly string[] }>)[id]?.deps ?? [])])
      for (const s of embedded) expect(allowed.has(s), `${id} embeds ${s}`).toBe(true)
    }
    // The non-trivial edges this relies on, so a grammar update can't silently
    // move them.
    expect(subLanguages('typescript')).toEqual(expect.arrayContaining(['xml', 'css']))
    expect(subLanguages('xml')).toEqual(expect.arrayContaining(['css', 'javascript']))
    expect(subLanguages('yaml')).toContain('ruby')
  })

  it('names every lazy grammar by exactly the tags the old instance resolved to it', () => {
    for (const id of LAZY_IDS) {
      const expected = [...OLD].filter(([, g]) => g === id).map(([name]) => name).sort()
      expect([...LAZY_GRAMMARS[id].names].sort(), id).toEqual(expected)
    }
  })

  it('leaves no gap before any load: a tag the old instance highlighted is registered now or names its grammar', () => {
    for (const tag of CANDIDATES) {
      const before = referenceLowlight.registered(tag)
      const now = lowlight.registered(tag)
      const lazy = lazyGrammarFor(tag)
      expect(now || lazy !== undefined, `tag ${JSON.stringify(tag)}`).toBe(before)
      if (now) expect(lazy).toBeUndefined()
      if (lazy) expect(lazy).toBe(OLD.get(tag.toLowerCase()))
    }
  })

  it('loads a grammar with its deps: yaml registers only once ruby is registered too', async () => {
    expect(lowlight.registered('yaml')).toBe(false)
    expect(lowlight.registered('ruby')).toBe(false)
    const pending = requestGrammar('yaml')
    expect(requestGrammar('yaml')).toBe(pending) // one load per grammar
    await pending
    expect(lowlight.registered('ruby')).toBe(true)
    expect(lowlight.registered('yml')).toBe(true)
    expect(lazyGrammarFor('yaml')).toBeUndefined()
  })

  it('after every load: same resolution and byte-identical output as the eager instance', async () => {
    // Load in reverse order on purpose: registration order must not matter.
    await Promise.all([...LAZY_IDS].reverse().map((id) => requestGrammar(id)))
    expect(allGrammarsRegistered()).toBe(true)
    for (const tag of CANDIDATES) {
      expect(lowlight.registered(tag), `tag ${JSON.stringify(tag)}`).toBe(referenceLowlight.registered(tag))
      expect(lazyGrammarFor(tag)).toBeUndefined()
    }
    for (const [tag, grammar] of OLD) {
      const code = SAMPLES[grammar]
      expect(lowlight.highlight(tag, code), `${tag} -> ${grammar}`).toEqual(referenceLowlight.highlight(tag, code))
    }
  })
})
