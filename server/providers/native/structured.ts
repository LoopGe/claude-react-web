// server/providers/native/structured.ts
//
// Neutral structured-output runtime: a terminal `StructuredOutput` tool whose
// parameter schema IS the caller's output schema, a guidance instruction, a
// bounded fail-closed argument validator, and a monotonic capture guard.
// Simplified from DSH's subagent structured.ts to native's tool pipeline:
// capture commits on a successful valid call (native's loop has no
// transformable tool-result waterfall, so no separate two-phase commit).
// How the loop denies other tools after capture is wired by the attachers
// (Agent/Task outputSchema, one-shot runStructured); this module exposes
// `isClosed()` and blocks a second capture itself.

import type { ToolDef } from './tools/types.js'

/** The model-facing tool name a structured run must call to finish. */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput'

/** The trailing guidance instruction: the demand travels with the tool. */
export const STRUCTURED_OUTPUT_GUIDANCE =
  'When you have your final answer, you MUST finish by calling the ' +
  `\`${STRUCTURED_OUTPUT_TOOL}\` tool with arguments matching its parameter schema exactly. ` +
  'A plain text answer does not count as your result.'

/** One structured run's live handle: read the captured value once the run settles. */
export interface StructuredAttachment {
  tool: ToolDef
  /** The committed value, or undefined while no valid call was accepted. */
  captured(): { value: unknown } | undefined
  /** True once a value was captured; monotonic — the run never reopens. */
  isClosed(): boolean
}

/**
 * Build the terminal capture tool for one structured run. `run` validates the
 * arguments against `schema`; a violation returns an error result so the model
 * retries within the same turn, a valid call captures the value and closes the
 * run. Every later call is rejected without touching the capture.
 */
export function attachStructuredRuntime(schema: Record<string, unknown>): StructuredAttachment {
  let captured: { value: unknown } | undefined

  const tool: ToolDef = {
    name: STRUCTURED_OUTPUT_TOOL,
    description:
      'Report your final structured result. Call this exactly once, when your answer is complete; ' +
      "the arguments must match this tool's parameter schema exactly.",
    guidance: STRUCTURED_OUTPUT_GUIDANCE,
    // Trailing: the finish demand reads after every other tool guidance.
    promptOrder: 210,
    schema,
    async run(input) {
      if (captured !== undefined) {
        return {
          text: 'Structured output already recorded: the run is complete, so this call is not executed.',
          isError: true,
        }
      }
      const violations = validateStructuredArgs(schema, input)
      if (violations.length > 0) {
        return {
          text:
            `${STRUCTURED_OUTPUT_TOOL} arguments do not match the parameter schema:\n` +
            violations.map(v => `- ${v}`).join('\n') +
            `\nCall ${STRUCTURED_OUTPUT_TOOL} again with corrected arguments.`,
          isError: true,
        }
      }
      captured = { value: input }
      return { text: 'Structured output recorded.' }
    },
  }

  return {
    tool,
    captured: () => captured,
    isClosed: () => captured !== undefined,
  }
}

/** Schema keywords the bounded validator implements. Anything else (anyOf,
 *  $ref, minimum, pattern, tuple items, type unions, ...) is a violation, not
 *  a silently ignored constraint — fail closed. `description` / `title` are
 *  pure annotations with no validation semantics and are skipped. */
const CONSTRAINT_KEYS = new Set(['type', 'properties', 'required', 'enum', 'items'])
const ANNOTATION_KEYS = new Set(['description', 'title'])
const SUPPORTED_TYPES = new Set(['object', 'string', 'number', 'boolean', 'array'])

/**
 * Validate a JSON value against the bounded schema subset (type:
 * object/string/number/boolean/array; properties; required; enum; items).
 * Returns human-readable violations; empty means conforming. Unsupported
 * schema constructs produce violations even when the value would otherwise
 * pass, so an unimplementable constraint can never silently accept.
 */
export function validateStructuredArgs(schema: Record<string, unknown>, value: unknown): string[] {
  const violations: string[] = []
  validateNode(schema, value, '$', violations)
  return violations
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The JSON kind of a value, for violation messages. */
function jsonKind(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object': return isRecord(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    default: return false
  }
}

/** Structural equality over JSON values (enum members may be objects/arrays). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]))
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
  }
  return false
}

function validateNode(schema: unknown, value: unknown, path: string, out: string[]): void {
  if (!isRecord(schema)) {
    out.push(`${path}: schema must be an object (tuple items and non-object schemas are unsupported)`)
    return
  }
  for (const key of Object.keys(schema)) {
    if (!CONSTRAINT_KEYS.has(key) && !ANNOTATION_KEYS.has(key)) {
      out.push(`${path}: unsupported schema keyword "${key}"`)
    }
  }

  if (Object.hasOwn(schema, 'type')) {
    const type = schema.type
    if (typeof type !== 'string' || !SUPPORTED_TYPES.has(type)) {
      out.push(`${path}: unsupported type ${JSON.stringify(type)}`)
      return
    }
    if (!matchesType(type, value)) {
      out.push(`${path}: expected ${type}, got ${jsonKind(value)}`)
      return
    }
  }

  if (Object.hasOwn(schema, 'enum')) {
    const members = schema.enum
    if (!Array.isArray(members)) {
      out.push(`${path}: enum must be an array`)
    } else if (!members.some(m => jsonEqual(m, value))) {
      out.push(`${path}: value ${JSON.stringify(value)} is not one of the allowed enum values`)
    }
  }

  // Object keywords apply only to object values (JSON Schema semantics).
  if (isRecord(value)) {
    if (Object.hasOwn(schema, 'required')) {
      const required = schema.required
      if (!Array.isArray(required) || required.some(k => typeof k !== 'string')) {
        out.push(`${path}: required must be an array of strings`)
      } else {
        for (const key of required) {
          if (!Object.hasOwn(value, key)) out.push(`${path}: missing required property "${key}"`)
        }
      }
    }
    if (Object.hasOwn(schema, 'properties')) {
      const properties = schema.properties
      if (!isRecord(properties)) {
        out.push(`${path}: properties must be an object`)
      } else {
        for (const [key, sub] of Object.entries(properties)) {
          if (Object.hasOwn(value, key)) validateNode(sub, value[key], `${path}.${key}`, out)
        }
      }
    }
  }

  if (Array.isArray(value) && Object.hasOwn(schema, 'items')) {
    for (let i = 0; i < value.length; i++) {
      validateNode(schema.items, value[i], `${path}[${i}]`, out)
    }
  }
}
