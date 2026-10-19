// The highlight grammars are registered EAGERLY: every block is highlighted on
// its first paint, with nothing loaded on demand. Pinned here against the
// independently written registration in src/test-utils/markdown-reference.ts:
// the same 24 grammars registered at import, every tag resolving to the same
// grammar (haskell, mermaid & co. staying plain), byte-identical output, and
// the diff-line gate (`isRegisteredLanguage`) accepting exactly the registered
// names and our aliases.

import { describe, it, expect } from 'vitest'
import hljs from 'highlight.js/lib/core'
import type { LanguageFn } from 'highlight.js'
import { isRegisteredLanguage, lowlight } from './lowlight-instance'
import { REFERENCE_CUSTOM_ALIASES, REFERENCE_GRAMMARS, referenceLowlight } from '../test-utils/markdown-reference'

type GrammarId = keyof typeof REFERENCE_GRAMMARS
const GRAMMAR_IDS = Object.keys(REFERENCE_GRAMMARS) as GrammarId[]

/** Registration order: the createLowlight object (html after php). */
const REGISTRATION_ORDER = [
  'javascript', 'typescript', 'python', 'bash', 'json', 'xml', 'css', 'java', 'cpp', 'go', 'rust', 'sql',
  'markdown', 'yaml', 'ruby', 'swift', 'kotlin', 'csharp', 'php', 'html', 'diff', 'dockerfile', 'makefile',
  'ini', 'properties',
] as const

function grammarOf(name: (typeof REGISTRATION_ORDER)[number]): GrammarId {
  return name === 'html' ? 'xml' : name
}

function ownAliases(id: GrammarId): string[] {
  return ((REFERENCE_GRAMMARS[id] as LanguageFn)(hljs).aliases ?? []).map((a) => a.toLowerCase())
}

/** Every tag the reference resolves, mapped to the grammar it resolves to.
 *  Replays hljs's own rule: language names first, then the alias map, where a
 *  later registration overwrites an alias and our aliases were applied last. */
function referenceResolution(): Map<string, GrammarId> {
  const languages = new Map<string, GrammarId>()
  const aliases = new Map<string, string>()
  for (const name of REGISTRATION_ORDER) {
    languages.set(name, grammarOf(name))
    for (const alias of ownAliases(grammarOf(name))) aliases.set(alias, name)
  }
  for (const [name, list] of Object.entries(REFERENCE_CUSTOM_ALIASES)) for (const alias of list) aliases.set(alias, name)
  const out = new Map<string, GrammarId>(languages)
  for (const [alias, name] of aliases) if (!out.has(alias)) out.set(alias, languages.get(name)!)
  return out
}

const RESOLVED = referenceResolution()
const NOT_OURS = [
  'haskell', 'mermaid', 'elixir', 'plaintext', 'text', 'txt', 'math', 'latex', 'tex', 'graphql', 'handlebars',
  'scss', 'less', 'console', 'shell-session', 'objectivec', 'vue', 'svelte', 'lua', 'perl', 'r', 'scala', 'dart',
  'zig', 'powershell', 'ps1', 'bat', 'cmd', 'not-a-real-language', 'c-like', 'json5', '', ' ',
]
/** Every tag worth asking about: all resolved names, case variants, and a
 *  spread of hljs languages the app never registered. */
const CANDIDATES = [...new Set([
  ...RESOLVED.keys(),
  ...[...RESOLVED.keys()].map((n) => n.toUpperCase()),
  ...[...RESOLVED.keys()].map((n) => n.charAt(0).toUpperCase() + n.slice(1)),
  ...NOT_OURS,
])]

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

describe('lowlight-instance: eager grammars', () => {
  it('registers all 24 grammars (and html) at import, so nothing is left to load', () => {
    expect(GRAMMAR_IDS).toHaveLength(24)
    for (const id of GRAMMAR_IDS) expect(lowlight.registered(id), id).toBe(true)
    expect(lowlight.registered('html')).toBe(true)
    expect([...lowlight.listLanguages()].sort()).toEqual([...referenceLowlight.listLanguages()].sort())
  })

  it('resolves every tag like the reference, with byte-identical output', () => {
    for (const tag of CANDIDATES) {
      expect(lowlight.registered(tag), `tag ${JSON.stringify(tag)}`).toBe(referenceLowlight.registered(tag))
    }
    expect(lowlight.registered('haskell')).toBe(false)
    expect(lowlight.registered('mermaid')).toBe(false)
    for (const [tag, grammar] of RESOLVED) {
      const code = SAMPLES[grammar]
      expect(lowlight.highlight(tag, code), `${tag} -> ${grammar}`).toEqual(referenceLowlight.highlight(tag, code))
    }
  })

  // Diff lines go through `isRegisteredLanguage`, a hand-maintained Set kept
  // apart from the createLowlight registration: a grammar registered without
  // its Set entry highlights fences while its diff lines stay plain.
  it('gates diff lines on exactly the registered names and our aliases', () => {
    const gated = new Set<string>([...REGISTRATION_ORDER, ...Object.values(REFERENCE_CUSTOM_ALIASES).flat()])
    for (const tag of gated) expect(lowlight.registered(tag), tag).toBe(true)
    for (const tag of new Set([...CANDIDATES, ...gated])) {
      expect(isRegisteredLanguage(tag), `tag ${JSON.stringify(tag)}`).toBe(gated.has(tag))
    }
    expect(isRegisteredLanguage(null)).toBe(false)
    expect(isRegisteredLanguage(undefined)).toBe(false)
  })
})
