// Shared lowlight instance with all the languages this app cares about.
//
// Markdown.tsx and the diff-line highlighter both need to call
// `lowlight.highlight(lang, text)`; they used to live in separate
// instances which meant double-registration overhead and easy drift.
// One source of truth lives here.
//
// Bundle note: each `highlight.js/lib/languages/*` import is ~2-8 KB
// pre-compression. The registered set covers what we see in actual
// transcripts; new languages should be added here AND any aliases
// registered below so `detectLanguage()` results land in the right
// grammar.

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

export const lowlight = createLowlight({
  javascript,
  typescript,
  python,
  bash,
  json,
  xml,
  css,
  java,
  cpp,
  go,
  rust,
  sql,
  markdown: markdownLang,
  yaml,
  ruby,
  swift,
  kotlin,
  csharp,
  php,
  html: xml, // xml grammar covers html
  diff,
  dockerfile,
  makefile,
  ini,
  properties,
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
  go: ['protobuf'], // close enough for proto highlighting
})

/** Set of languages registered above (plus their aliases). Use this to
 *  guard `lowlight.highlight()` calls — passing an unknown language to
 *  lowlight throws, which we don't want inside React render. */
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

export function isRegisteredLanguage(lang: string): boolean {
  return REGISTERED.has(lang)
}
