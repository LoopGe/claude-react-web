import { resolve } from 'node:path'
import { parseSkillFrontmatter } from '../../../shared/skills.js'

/** Render the stable instruction body shared by `/name` and the Skill tool. */
export function renderNativeSkillBody(input: { directory: string; document: string }): string {
  const parsed = parseSkillFrontmatter(input.document)
  if (parsed.body === undefined || parsed.errors.length > 0) {
    throw new Error(`Invalid SKILL.md: ${parsed.errors.join('; ')}`)
  }
  // A single empty line between frontmatter and body is the document's
  // separator; the canonical prefix owns that separator in the rendered form.
  const body = parsed.body.replace(/^\r?\n/, '')
  return `Base directory for this skill: ${resolve(input.directory)}\n\n${body}`
}

/** Only the model tool protocol carries arguments; slash expansion does not. */
export function renderNativeSkillToolResult(body: string, args: string): string {
  return args.trim() ? `${body}\n\n## User Request\n${args}` : body
}

/** CLI GWe's accumulated-size limit: body plus filled arguments, in characters. */
const MAX_SKILL_ARGUMENT_CHARS = 4_000_000

/**
 * Stands in for a literal `$` while substitution passes run: escaped `\$` and
 * every inserted `$` become this sentinel, so no later pass can match them, and
 * the final restore turns them back into literal dollars. Skill bodies and
 * argument text are ordinary prose and never carry a NUL.
 */
const DOLLAR_SENTINEL = String.fromCharCode(0)

/**
 * Quote-aware shell-style argument tokenizer: single/double-quoted spans keep
 * their whitespace, outer quotes are stripped, and `\x` unescapes to `x`. A
 * deliberate lightweight stand-in for the CLI's tree-sitter shell path — native
 * substitutes into instruction text and never executes a shell, so unsafe-node
 * rejection is unnecessary. Falls back to whitespace splitting when no token
 * survives (mirrors the CLI's `rxo`).
 */
export function splitSkillArgs(args: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inToken = false
  let quote: string | null = null
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]
    if (ch === '\\' && i + 1 < args.length) {
      current += args[++i]
      inToken = true
      continue
    }
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (inToken) tokens.push(current)
      current = ''
      inToken = false
      continue
    }
    current += ch
    inToken = true
  }
  if (inToken) tokens.push(current)
  return tokens.length > 0 ? tokens : args.split(/\s+/).filter(Boolean)
}

/**
 * Positional argument substitution matching the CLI's GWe contract: `$N` and
 * `$ARGUMENTS[N]` are 0-based token indices (out-of-range stays literal),
 * `$ARGUMENTS` inserts the whole raw args string, and a `\n\nARGUMENTS: <args>`
 * fallback is appended only when `$ARGUMENTS` did not match and args are
 * non-empty. Inserted text is never re-substituted; escaped `\$` renders a
 * literal `$`. Throws when the accumulated body-plus-arguments size exceeds
 * 4,000,000 characters. Named `$arg` placeholders and `${CLAUDE_*}` directory
 * templating are out of scope.
 */
export function substituteSkillArguments(body: string, args: string): string {
  let size = body.length
  const account = (rawLength: number, insertedLength: number): void => {
    size += Math.max(rawLength, insertedLength)
    if (size > MAX_SKILL_ARGUMENT_CHARS) {
      throw new Error(
        'This skill and the arguments filled into it add up to more than 4,000,000 characters. Use shorter arguments or fewer placeholders such as $ARGUMENTS.',
      )
    }
  }
  const protect = (value: string): string => value.replaceAll('$', DOLLAR_SENTINEL)

  // Escape pass: a constant sentinel replacement (no callback), so it cannot
  // set the matched flag — the CLI declares that flag only after this pass.
  let text = body.replace(/(?<!\\)\\\$(?=\d|ARGUMENTS)/g, DOLLAR_SENTINEL)
  let matched = false
  let tokens: string[] | undefined
  const tokenAt = (index: number): string | undefined => (tokens ??= splitSkillArgs(args))[index]

  text = text.replace(/\$ARGUMENTS\[(\d+)\]/g, (match, digits: string) => {
    const value = tokenAt(Number.parseInt(digits, 10))
    if (value === undefined) {
      account(match.length, match.length)
      return DOLLAR_SENTINEL + match.slice(1)
    }
    account(match.length, value.length)
    return protect(value)
  })
  text = text.replace(/\$(\d+)(?!\w)/g, (match, digits: string) => {
    const value = tokenAt(Number.parseInt(digits, 10))
    if (value === undefined) {
      account(match.length, match.length)
      return match
    }
    account(match.length, value.length)
    return protect(value)
  })
  text = text.replaceAll('$ARGUMENTS', () => {
    matched = true
    account('$ARGUMENTS'.length, args.length)
    return protect(args)
  })
  if (!matched && args) {
    const appended = `\n\nARGUMENTS: ${args}`
    account(0, appended.length)
    text += appended
  }
  return text.replaceAll(DOLLAR_SENTINEL, '$')
}
