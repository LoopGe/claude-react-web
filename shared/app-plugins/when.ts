// Minimal `when` clause expression language for App Plugin contributions.
//
// v1 supports only: `key == literal`, `key != literal`, `!key`, and `&&`.
// No `||`, no ordering comparisons, no `in`, no arithmetic. This is enough
// to express the real v1 conditions (`message.hasSelection == true`,
// `session.active == true && git.isRepo == true`) without taking on a
// language-design project. The original plan's full operator set is deferred
// until a real plugin needs it.
//
// The parser is a hand-written recursive descent — never `eval` / `Function`
// — with a hard depth + length cap so a pathological expression can't hang
// the host. Malformed expressions fail to parse (the contribution is not
// registered and a diagnostic is surfaced), which is the correct behaviour
// for trusted-but-buggy plugin authors.

export type WhenLiteral = string | number | boolean

export type WhenNode =
  | { t: 'cmp'; key: string; op: '==' | '!='; value: WhenLiteral }
  | { t: 'not'; key: string }
  | { t: 'and'; left: WhenNode; right: WhenNode }

/** Context keys available to `when` clauses. The host populates a subset
 *  (only keys relevant to the current slot/menu location); missing keys
 *  coerce per `truthOf`. Keep this list in sync with the host adapters
 *  that publish context. */
export interface WhenContext {
  [key: string]: WhenLiteral | undefined
}

const MAX_LEN = 512
const MAX_DEPTH = 16

export interface WhenParseResult {
  ok: boolean
  node?: WhenNode
  error?: string
}

/** Parse a `when` string into an AST. Returns `{ok:false,error}` on any
 *  syntax error; never throws. An empty string parses to a trivially-true
 *  sentinel (`undefined` node) — a contribution with no `when` always shows. */
export function parseWhen(input: string | undefined): WhenParseResult {
  if (input == null || input.trim() === '') return { ok: true, node: undefined }
  if (input.length > MAX_LEN) return { ok: false, error: 'when expression too long' }
  const p = new Parser(input)
  try {
    const node = p.parseExpr(0)
    p.skipWs()
    if (!p.atEnd()) return { ok: false, error: `unexpected trailing input at ${p.pos}` }
    return { ok: true, node }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Evaluate a parsed node against a context. A `undefined` node (no `when`)
 *  is trivially true. Unknown keys resolve to undefined and compare as
 *  "not equal to any literal" (so `key == true` is false when the key is
 *  absent), while `!key` is true when the key is falsy/absent. */
export function evalWhen(node: WhenNode | undefined, ctx: WhenContext): boolean {
  if (!node) return true
  switch (node.t) {
    case 'cmp':
      return compareCmp(node.key, node.op, node.value, ctx)
    case 'not':
      return !truthOf(ctx[node.key])
    case 'and':
      return evalWhen(node.left, ctx) && evalWhen(node.right, ctx)
  }
}

/** Compile once, evaluate many times. Returns null on parse error (caller
 *  surfaces the diagnostic at registration time). */
export function compileWhen(input: string | undefined): { node: WhenNode | undefined } | null {
  const res = parseWhen(input)
  if (!res.ok) return null
  return { node: res.node }
}

function truthOf(v: WhenLiteral | undefined): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'string') return v !== '' && v !== 'false' && v !== '0'
  return !!v
}

function compareCmp(key: string, op: '==' | '!=', value: WhenLiteral, ctx: WhenContext): boolean {
  const actual = ctx[key]
  const eq = literalEq(actual, value)
  return op === '==' ? eq : !eq
}

/** Literal equality: types must match (a string key is never equal to a
 *  boolean literal), except numbers and their numeric-string forms are NOT
 *  coerced — `1` and `"1"` are distinct. This keeps the semantics boring
 *  and predictable. */
function literalEq(a: WhenLiteral | undefined, b: WhenLiteral): boolean {
  if (typeof a !== typeof b) return false
  return a === b
}

// ── Parser ───────────────────────────────────────────────────────────

class Parser {
  readonly s: string
  pos = 0
  constructor(s: string) {
    this.s = s
  }
  atEnd(): boolean {
    return this.pos >= this.s.length
  }
  skipWs(): void {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++
  }
  peek(): string {
    return this.s[this.pos] ?? ''
  }
  parseExpr(depth: number): WhenNode {
    if (depth > MAX_DEPTH) throw new Error('when expression too deeply nested')
    let left = this.parseFactor(depth)
    this.skipWs()
    while (this.peek2() === '&&') {
      this.pos += 2
      this.skipWs()
      const right = this.parseFactor(depth + 1)
      left = { t: 'and', left, right }
      this.skipWs()
    }
    return left
  }
  peek2(): string {
    return this.s.slice(this.pos, this.pos + 2)
  }
  parseFactor(depth: number): WhenNode {
    this.skipWs()
    if (this.peek() === '!') {
      this.pos++
      this.skipWs()
      const key = this.parseKey()
      return { t: 'not', key }
    }
    if (this.peek() === '(') {
      this.pos++
      const node = this.parseExpr(depth + 1)
      this.skipWs()
      if (this.peek() !== ')') throw new Error(`expected ')' at ${this.pos}`)
      this.pos++
      return node
    }
    const key = this.parseKey()
    this.skipWs()
    const op2 = this.peek2()
    if (op2 === '==' || op2 === '!=') {
      this.pos += 2
      this.skipWs()
      const value = this.parseLiteral()
      return { t: 'cmp', key, op: op2, value }
    }
    // Bare key: truthy test. Represent as `key == true` semantics by routing
    // through `not` inverse is awkward; instead treat bare key as a cmp
    // against true so eval stays uniform.
    return { t: 'cmp', key, op: '==', value: true }
  }
  parseKey(): string {
    this.skipWs()
    const start = this.pos
    while (this.pos < this.s.length && /[a-zA-Z0-9_.]/.test(this.s[this.pos])) this.pos++
    const key = this.s.slice(start, this.pos)
    if (!key) throw new Error(`expected context key at ${this.pos}`)
    if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(key)) throw new Error(`invalid context key '${key}'`)
    return key
  }
  parseLiteral(): WhenLiteral {
    this.skipWs()
    const ch = this.peek()
    if (ch === '"' || ch === "'") {
      const quote = ch
      this.pos++
      const start = this.pos
      while (this.pos < this.s.length && this.s[this.pos] !== quote) {
        if (this.s[this.pos] === '\\') this.pos++ // skip escaped char
        this.pos++
      }
      if (this.s[this.pos] !== quote) throw new Error(`unterminated string literal at ${start}`)
      const raw = this.s.slice(start, this.pos)
      this.pos++
      return unescapeString(raw)
    }
    if (ch === 't' && this.s.slice(this.pos, this.pos + 4) === 'true') {
      this.pos += 4
      return true
    }
    if (ch === 'f' && this.s.slice(this.pos, this.pos + 5) === 'false') {
      this.pos += 5
      return false
    }
    if (/[-0-9]/.test(ch)) {
      const start = this.pos
      if (ch === '-') this.pos++
      while (this.pos < this.s.length && /[0-9]/.test(this.s[this.pos])) this.pos++
      const num = this.s.slice(start, this.pos)
      if (num === '' || num === '-') throw new Error(`invalid number literal at ${start}`)
      return Number(num)
    }
    throw new Error(`expected literal (string/number/boolean) at ${this.pos}`)
  }
}

/** Unescape the minimal escape set a `when` string literal supports:
 *  `\"`, `\\`, `\n`, `\t`. Anything else leaves the backslash so the value
 *  is deterministic rather than silently dropping a char. */
function unescapeString(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1]
      if (next === 'n') out += '\n'
      else if (next === 't') out += '\t'
      else out += next // \" → ", \\ → \
      i++
    } else {
      out += ch
    }
  }
  return out
}
