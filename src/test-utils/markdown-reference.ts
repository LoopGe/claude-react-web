// Test-only REFERENCE for the highlight grammars: the lowlight registration
// the app ships, written out independently — all 24 grammars registered up
// front (same order, same aliases). lowlight-instance.test.ts compares the
// real instance against it, so "every tag resolves to the same grammar, with
// byte-identical output, and nothing is left to load on demand" is checked,
// not assumed.
//
// Keep it frozen: it must NOT import lowlight-instance.ts. A deliberate change
// to what the app registers fails that test until this reference changes with
// it.

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

/** The 24 grammars, in registration order (html, an xml alias, after php). */
export const REFERENCE_GRAMMARS = {
  javascript, typescript, python, bash, json, xml, css, java, cpp, go, rust, sql,
  markdown: markdownLang, yaml, ruby, swift, kotlin, csharp, php, diff, dockerfile,
  makefile, ini, properties,
} as const

/** Our aliases, as lowlight-instance.ts registers them. */
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
