// Safe parsing of a Workflow script's `meta` literal and of the Workflow
// tool_result payload (WorkflowOutput).
//
// Why this exists: the SDK `WorkflowInput` schema exposes only
// script / name / args / scriptPath / resumeFromRunId — there is no `meta`
// field. `meta` lives INSIDE the `script` string as
// `export const meta = { name, description, phases }`. So to surface the
// workflow's real name + declared phase tree on the WorkflowCard / overlay,
// we must parse it out of the script source that the model emitted in the
// tool_use input. Likewise the Workflow's own tool_result carries a JSON
// `WorkflowOutput` (status / taskType / runId / scriptPath / sessionUrl) that
// we want to render (notably sessionUrl for remote/cloud workflows).
//
// Safety: the script is MODEL-GENERATED text. We must never `eval` / `new
// Function` it. `parseWorkflowMeta` runs a hand-rolled recursive-descent
// parser that accepts ONLY a restricted literal subset
// (strings / numbers / booleans / null / arrays / objects, quoted OR
// unquoted keys, trailing commas). On ANY token outside that subset (function
// expressions, identifiers-as-values, template interpolation `${…}`, `…spread`)
// it bails to the empty result instead of evaluating. The docs guarantee meta
// is a "pure literal, no computed values", so a bail is a malformed script,
// not a supported case we'd mishandle.
//
// Every parse is non-fatal: failure returns the empty meta / null output, and
// the WorkflowRecord keeps working at its previous (degraded) fidelity.

import type { WorkflowPhaseMeta } from './types'

export interface ParsedWorkflowMeta {
  /** Script's declared `meta.name`. */
  name?: string
  /** Declared phases from `meta.phases`, in declaration order. `[]` when the
   *  script has no phases or the literal failed to parse. */
  phases: WorkflowPhaseMeta[]
}

export interface ParsedWorkflowOutput {
  status?: 'async_launched' | 'remote_launched'
  taskType?: 'local_workflow' | 'remote_agent'
  workflowName?: string
  runId?: string
  scriptPath?: string
  sessionUrl?: string
  transcriptDir?: string
}

// ─── meta literal extraction ───────────────────────────────────────────────

const META_DECL_RE = /export\s+const\s+meta\s*=\s*/

/** Extract the `export const meta = {…}` object literal slice from a script.
 *  Returns the text INCLUDING the outer braces, or null when there's no meta
 *  declaration. String/comment-aware brace matching so a `}` inside a string
 *  or comment can't terminate the object early. */
function extractMetaLiteral(script: string): string | null {
  const decl = META_DECL_RE.exec(script)
  if (!decl) return null
  let i = decl.index! + decl[0].length
  // Skip whitespace/comments to the opening brace.
  i = skipTrivia(script, i)
  if (script[i] !== '{') return null
  const start = i
  let depth = 0
  while (i < script.length) {
    const ch = script[i]
    // Line comment
    if (ch === '/' && script[i + 1] === '/') {
      i = script.indexOf('\n', i + 2)
      if (i < 0) return null
      continue
    }
    // Block comment
    if (ch === '/' && script[i + 1] === '*') {
      const end = script.indexOf('*/', i + 2)
      if (end < 0) return null
      i = end + 2
      continue
    }
    // String literals — skip their bodies so braces/colons inside them can't
    // confuse the depth counter. Backtick strings need ${…} handling: we bail
    // on an unescaped `${` because that's a computed value (out of subset).
    if (ch === '"' || ch === "'" || ch === '`') {
      const res = skipString(script, i, ch)
      if (res < 0) return null // unterminated, or ${…} in a backtick string
      i = res
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return script.slice(start, i + 1)
    }
    i++
  }
  return null // unmatched braces
}

/** Skip over a string literal opened with `quote` (' " `), honoring escape
 *  sequences. Returns the index PAST the closing quote. Returns -1 if
 *  unterminated, or if a backtick string contains an unescaped `${`
 *  (computed interpolation — out of the safe subset, so bail). */
function skipString(script: string, start: number, quote: string): number {
  let i = start + 1
  while (i < script.length) {
    const ch = script[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (quote === '`' && ch === '$' && script[i + 1] === '{') {
      return -1 // computed interpolation — bail
    }
    if (ch === quote) return i + 1
    i++
  }
  return -1 // unterminated
}

/** Skip whitespace and comments starting at `i`, returning the next index. */
function skipTrivia(script: string, i: number): number {
  while (i < script.length) {
    const ch = script[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    if (ch === '/' && script[i + 1] === '/') {
      const nl = script.indexOf('\n', i + 2)
      i = nl < 0 ? script.length : nl + 1
      continue
    }
    if (ch === '/' && script[i + 1] === '*') {
      const end = script.indexOf('*/', i + 2)
      i = end < 0 ? script.length : end + 2
      continue
    }
    break
  }
  return i
}

// ─── restricted-literal recursive-descent parser ───────────────────────────
//
// Accepts ONLY: string | number | boolean | null | array | object.
// Object keys may be quoted (' " `) or bare identifier-like. Trailing commas
// allowed. Throws `ParseBail` (caught by the entry point) on anything else,
// which the caller turns into the empty meta.

class ParseBail extends Error {}

class LitParser {
  private s: string
  private i = 0
  constructor(literal: string) {
    this.s = literal
  }

  parse(): unknown {
    this.i = skipTrivia(this.s, this.i)
    const v = this.parseValue()
    this.i = skipTrivia(this.s, this.i)
    if (this.i !== this.s.length) throw new ParseBail('trailing tokens')
    return v
  }

  private parseValue(): unknown {
    this.i = skipTrivia(this.s, this.i)
    const ch = this.s[this.i]
    if (ch === '{') return this.parseObject()
    if (ch === '[') return this.parseArray()
    if (ch === '"' || ch === "'" || ch === '`') return this.parseString(ch)
    // number, boolean, null
    return this.parseLiteralToken()
  }

  private parseObject(): Record<string, unknown> {
    this.i++ // {
    const obj: Record<string, unknown> = {}
    this.i = skipTrivia(this.s, this.i)
    if (this.s[this.i] === '}') {
      this.i++
      return obj
    }
    while (true) {
      this.i = skipTrivia(this.s, this.i)
      const key = this.parseKey()
      this.i = skipTrivia(this.s, this.i)
      if (this.s[this.i] !== ':') throw new ParseBail('expected : after key')
      this.i++
      const value = this.parseValue()
      obj[key] = value
      this.i = skipTrivia(this.s, this.i)
      const c = this.s[this.i]
      if (c === ',') {
        this.i++
        this.i = skipTrivia(this.s, this.i)
        // allow trailing comma
        if (this.s[this.i] === '}') {
          this.i++
          break
        }
        continue
      }
      if (c === '}') {
        this.i++
        break
      }
      throw new ParseBail('expected , or }')
    }
    return obj
  }

  private parseArray(): unknown[] {
    this.i++ // [
    const arr: unknown[] = []
    this.i = skipTrivia(this.s, this.i)
    if (this.s[this.i] === ']') {
      this.i++
      return arr
    }
    while (true) {
      const value = this.parseValue()
      arr.push(value)
      this.i = skipTrivia(this.s, this.i)
      const c = this.s[this.i]
      if (c === ',') {
        this.i++
        this.i = skipTrivia(this.s, this.i)
        if (this.s[this.i] === ']') {
          this.i++
          break
        }
        continue
      }
      if (c === ']') {
        this.i++
        break
      }
      throw new ParseBail('expected , or ]')
    }
    return arr
  }

  private parseKey(): string {
    const ch = this.s[this.i]
    if (ch === '"' || ch === "'" || ch === '`') return this.parseString(ch)
    // bare key: [A-Za-z_$][A-Za-z0-9_$]*
    const start = this.i
    if (!/[A-Za-z_$]/.test(ch)) throw new ParseBail('bad key')
    while (this.i < this.s.length && /[A-Za-z0-9_$]/.test(this.s[this.i])) this.i++
    return this.s.slice(start, this.i)
  }

  private parseString(quote: string): string {
    const start = this.i
    const res = skipString(this.s, this.i, quote)
    if (res < 0) throw new ParseBail('unterminated/bad string')
    const raw = this.s.slice(start + 1, res - 1)
    this.i = res
    return unescape(raw, quote)
  }

  private parseLiteralToken(): unknown {
    const start = this.i
    const ch = this.s[this.i]
    if (ch === '-' || ch === '+' || /[0-9.]/.test(ch)) {
      // number-ish; consume a run of [0-9.eE+-]
      while (this.i < this.s.length && /[0-9.eE+\-xXa-fA-F]/.test(this.s[this.i])) this.i++
      const tok = this.s.slice(start, this.i)
      const n = Number(tok)
      if (Number.isNaN(n)) throw new ParseBail('bad number')
      return n
    }
    // identifier: true / false / null (only these are allowed)
    if (/[A-Za-z_$]/.test(ch)) {
      while (this.i < this.s.length && /[A-Za-z0-9_$]/.test(this.s[this.i])) this.i++
      const tok = this.s.slice(start, this.i)
      if (tok === 'true') return true
      if (tok === 'false') return false
      if (tok === 'null') return null
      // Any other identifier (undefined, a variable, Infinity, NaN-as-ident,
      // function…) is OUT of the literal subset — bail.
      throw new ParseBail('identifier not allowed: ' + tok)
    }
    throw new ParseBail('unexpected token')
  }
}

/** Decode common JS string escapes for ' " and ` quotes. Best-effort — we only
 *  need readable text for display, not exact round-tripping. */
function unescape(raw: string, _quote: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = raw[i + 1]
    switch (next) {
      case 'n': out += '\n'; i++; break
      case 't': out += '\t'; i++; break
      case 'r': out += '\r'; i++; break
      case 'b': out += '\b'; i++; break
      case 'f': out += '\f'; i++; break
      case 'v': out += '\v'; i++; break
      case '0': out += '\0'; i++; break
      case '\\': out += '\\'; i++; break
      case "'": out += "'"; i++; break
      case '"': out += '"'; i++; break
      case '`': out += '`'; i++; break
      case '/': out += '/'; i++; break
      case 'x': {
        const hex = raw.slice(i + 2, i + 4)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16))
          i += 3
        } else {
          out += 'x'
        }
        break
      }
      case 'u': {
        if (raw[i + 2] === '{') {
          const end = raw.indexOf('}', i + 3)
          if (end > 0) {
            const hex = raw.slice(i + 3, end)
            if (/^[0-9a-fA-F]+$/.test(hex)) {
              out += String.fromCodePoint(parseInt(hex, 16))
              i = end
              break
            }
          }
          out += 'u'
        } else {
          const hex = raw.slice(i + 2, i + 6)
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16))
            i += 5
          } else {
            out += 'u'
          }
        }
        break
      }
      default:
        // Unknown escape — keep the char literally.
        out += next ?? ''
        i++
    }
  }
  return out
}

/** Coerce a parsed value into a WorkflowPhaseMeta. Accepts objects with at
 *  least a string `title`; `detail` is kept if it's a string. Anything else
 *  yields null (caller skips it). */
function toPhase(v: unknown): WorkflowPhaseMeta | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.title !== 'string' || !o.title) return null
  return {
    title: o.title,
    detail: typeof o.detail === 'string' ? o.detail : undefined,
  }
}

// ─── public entry points ───────────────────────────────────────────────────

/** Parse `export const meta = {…}` out of a workflow script and return its
 *  `name` + declared `phases`. Never throws: returns `{ phases: [] }` (and no
 *  name) when the script has no meta, the literal is malformed, or contains a
 *  non-literal token (bail). */
export function parseWorkflowMeta(script: string): ParsedWorkflowMeta {
  if (typeof script !== 'string' || !script) return { phases: [] }
  const literal = extractMetaLiteral(script)
  if (!literal) return { phases: [] }
  let obj: unknown
  try {
    obj = new LitParser(literal).parse()
  } catch {
    return { phases: [] }
  }
  if (!obj || typeof obj !== 'object') return { phases: [] }
  const o = obj as Record<string, unknown>
  const name = typeof o.name === 'string' && o.name ? o.name : undefined
  const phases: WorkflowPhaseMeta[] = []
  if (Array.isArray(o.phases)) {
    for (const p of o.phases) {
      const phase = toPhase(p)
      if (phase) phases.push(phase)
    }
  }
  return { name, phases }
}

/** Flatten a tool_result `content` (string | block array) to text, reusing the
 *  same convention as normalize.ts's private textOfContent. Exported here so
 *  workflow-meta.ts has no dependency cycle on normalize.ts. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: unknown }>)
    .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** Pull the outermost `{…}` out of a blob of text (the JSON may be wrapped in
 *  prose like "Workflow started.\n{...}"). Returns null if no balanced braces. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr: string | null = null
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' ) inStr = '"'
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** Parse a WorkflowOutput from a tool_result content blob. Flattens to text,
 *  finds the outermost JSON object, JSON.parses it, and picks known fields
 *  defensively. Returns null when the content isn't JSON or lacks a status.
 *  Never throws. */
export function parseWorkflowOutput(content: unknown): ParsedWorkflowOutput | null {
  const text = flattenContent(content)
  if (!text) return null
  const jsonText = extractJsonObject(text)
  if (!jsonText) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  const status = o.status
  if (status !== 'async_launched' && status !== 'remote_launched') {
    // Not a WorkflowOutput-shaped payload (could be a plain summary string the
    // CLI sometimes returns). Nothing useful to harvest.
    return null
  }
  const pickStr = (k: string): string | undefined =>
    typeof o[k] === 'string' ? (o[k] as string) : undefined
  return {
    status,
    taskType:
      o.taskType === 'local_workflow' || o.taskType === 'remote_agent' ? o.taskType : undefined,
    workflowName: pickStr('workflowName'),
    runId: pickStr('runId'),
    scriptPath: pickStr('scriptPath'),
    sessionUrl: pickStr('sessionUrl'),
    transcriptDir: pickStr('transcriptDir'),
  }
}

/** Basename of a scriptPath for the label fallback ladder. e.g.
 *  "/x/y/spec.mjs" -> "spec". Returns '' when there's no usable stem. */
export function scriptPathBasename(path: string): string {
  if (typeof path !== 'string' || !path) return ''
  const base = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  // Strip a trailing extension.
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return stem
}
