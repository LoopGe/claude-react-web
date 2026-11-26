// server/providers/native/structured.ts
//
// Neutral structured-output runtime: a terminal `StructuredOutput` tool whose
// parameter schema IS the caller's output schema, a guidance instruction, a
// bounded argument validator, and a monotonic capture guard. Simplified from
// DSH's subagent structured.ts to native's tool pipeline: capture commits on a
// successful valid call (native's loop has no transformable tool-result
// waterfall, so no separate two-phase commit). How the loop denies other tools
// after capture is wired by the attachers (Agent/Task outputSchema, one-shot
// runStructured); this module exposes `isClosed()` and blocks a second capture
// itself.
//
// Two failure classes, deliberately separated:
//   • Schema-unsupported — a construct the bounded validator cannot handle is
//     a caller/wiring error that no corrected arguments can ever satisfy. A
//     one-time shape scan at attach throws a clear Error naming the construct
//     (value-independently, so e.g. tuple `items` fails even for an empty
//     array). It never reaches the model as a retry instruction.
//   • Value-nonconforming — a supported schema with bad arguments returns
//     `{ text, isError: true }` so the model retries within the same turn.

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
 * Build the terminal capture tool for one structured run. Throws immediately
 * when `schema` uses a construct outside the supported subset (see
 * `assertSupportedSchema`). `run` validates the arguments against the schema;
 * a violation returns an error result so the model retries within the same
 * turn, a valid call captures the value and closes the run. Every later call
 * is rejected without touching the capture.
 */
export function attachStructuredRuntime(schema: Record<string, unknown>): StructuredAttachment {
  assertSupportedSchema(schema, '$')
  let captured: { value: unknown } | undefined

  const tool: ToolDef = {
    name: STRUCTURED_OUTPUT_TOOL,
    description:
      'Report your final structured result. Call this exactly once, when your answer is complete; ' +
      "the arguments must match this tool's parameter schema exactly.",
    guidance: STRUCTURED_OUTPUT_GUIDANCE,
    // Trailing: the finish demand reads after every other tool guidance.
    promptOrder: 210,
    // The capture records the run's answer — no filesystem mutation, no
    // network. Read-only evidence for the permission gates: the broker's
    // plan gate and the headless one-shot gate auto-allow on this hint, so
    // a structured run can finish without a prompt. (dontAsk consults the
    // broker's READONLY_TOOL_NAMES set, which also lists StructuredOutput.)
    readOnlyHint: true,
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
 *  $ref, minimum, pattern, object-form additionalProperties, ...) fails the
 *  attach-time scan. `description` / `title` are pure annotations with no
 *  validation semantics and are skipped. */
const CONSTRAINT_KEYS = new Set(['type', 'properties', 'required', 'enum', 'items', 'additionalProperties'])
const ANNOTATION_KEYS = new Set(['description', 'title'])
const SUPPORTED_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array', 'null'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function unsupportedSchema(path: string, detail: string): Error {
  return new Error(`Unsupported structured-output schema at ${path}: ${detail}`)
}

/**
 * One-time, value-independent shape scan of the caller's schema. Throws on
 * any construct outside the supported subset, naming the construct and its
 * path — an unsupported schema is a caller/wiring error, never a retryable
 * model instruction. Recurses through `properties` and `items` so nested
 * unsupported constructs (including tuple-form or non-object `items`, which
 * a value-driven walk would skip for an empty array) fail here at attach.
 * A root declaring `type` must declare `object` (tool arguments are JSON
 * objects); a properties-only root without `type` is accepted.
 */
function assertSupportedSchema(schema: unknown, path: string): void {
  if (!isRecord(schema)) {
    throw unsupportedSchema(path, 'schema must be an object (tuple items and non-object schemas are unsupported)')
  }
  for (const key of Object.keys(schema)) {
    if (!CONSTRAINT_KEYS.has(key) && !ANNOTATION_KEYS.has(key)) {
      throw unsupportedSchema(path, `unsupported schema keyword "${key}"`)
    }
  }
  if (Object.hasOwn(schema, 'type')) {
    const type = schema.type
    if (typeof type !== 'string' || !SUPPORTED_TYPES.has(type)) {
      throw unsupportedSchema(path, `unsupported type ${JSON.stringify(type)}`)
    }
    // Tool arguments are always JSON objects, so a root declaring any other
    // type is an unsatisfiable input_schema — a caller error, shape-provable
    // here without inspecting any value.
    if (path === '$' && type !== 'object') {
      throw unsupportedSchema(path, `root type must be "object" (tool arguments are JSON objects), got ${JSON.stringify(type)}`)
    }
  }
  if (Object.hasOwn(schema, 'enum') && !Array.isArray(schema.enum)) {
    throw unsupportedSchema(path, 'enum must be an array')
  }
  if (Object.hasOwn(schema, 'required')) {
    const required = schema.required
    if (!Array.isArray(required) || required.some(k => typeof k !== 'string')) {
      throw unsupportedSchema(path, 'required must be an array of strings')
    }
  }
  if (Object.hasOwn(schema, 'properties')) {
    const properties = schema.properties
    if (!isRecord(properties)) {
      throw unsupportedSchema(path, 'properties must be an object')
    }
    for (const [key, sub] of Object.entries(properties)) {
      assertSupportedSchema(sub, `${path}.${key}`)
    }
  }
  if (Object.hasOwn(schema, 'items')) {
    assertSupportedSchema(schema.items, `${path}.items`)
  }
  if (Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') {
    throw unsupportedSchema(path, 'additionalProperties must be a boolean (schema form is unsupported)')
  }
}

/**
 * Validate a JSON value against the supported schema subset (type:
 * object/string/number/integer/boolean/array/null; properties; required;
 * enum; items; boolean additionalProperties). Returns human-readable
 * violations; empty means conforming. Precondition: `schema` passed
 * `assertSupportedSchema` (attach does this once) — shape errors are the
 * attach-time failure class, not violations here.
 */
export function validateStructuredArgs(schema: Record<string, unknown>, value: unknown): string[] {
  const violations: string[] = []
  validateNode(schema, value, '$', violations)
  return violations
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
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
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

/** Value validation over an attach-asserted schema: every keyword present is
 *  supported and well-shaped, so the casts below read facts the scan proved. */
function validateNode(schema: Record<string, unknown>, value: unknown, path: string, out: string[]): void {
  if (Object.hasOwn(schema, 'type')) {
    const type = schema.type as string
    if (!matchesType(type, value)) {
      out.push(`${path}: expected ${type}, got ${jsonKind(value)}`)
      return
    }
  }

  if (Object.hasOwn(schema, 'enum')) {
    const members = schema.enum as unknown[]
    if (!members.some(m => jsonEqual(m, value))) {
      out.push(`${path}: value ${JSON.stringify(value)} is not one of the allowed enum values`)
    }
  }

  // Object keywords apply only to object values (JSON Schema semantics).
  if (isRecord(value)) {
    if (Object.hasOwn(schema, 'required')) {
      for (const key of schema.required as string[]) {
        if (!Object.hasOwn(value, key)) out.push(`${path}: missing required property "${key}"`)
      }
    }
    const properties = Object.hasOwn(schema, 'properties')
      ? schema.properties as Record<string, unknown>
      : undefined
    if (properties !== undefined) {
      for (const [key, sub] of Object.entries(properties)) {
        if (Object.hasOwn(value, key)) {
          validateNode(sub as Record<string, unknown>, value[key], `${path}.${key}`, out)
        }
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (properties === undefined || !Object.hasOwn(properties, key)) {
          out.push(`${path}.${key}: additional property not allowed by the schema`)
        }
      }
    }
  }

  if (Array.isArray(value) && Object.hasOwn(schema, 'items')) {
    const items = schema.items as Record<string, unknown>
    for (let i = 0; i < value.length; i++) {
      validateNode(items, value[i], `${path}[${i}]`, out)
    }
  }
}
