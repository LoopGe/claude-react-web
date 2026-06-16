/**
 * Lightweight AI security classifier for auto-mode permission checks.
 *
 * When a session is in 'auto' mode, every tool call that isn't on the
 * safe-allowlist passes through this classifier. A fast/cheap model
 * (haiku by default) evaluates whether the action is safe and returns
 * an allow/block decision.
 *
 * Design principles:
 *   - Fail-closed: every error, timeout, or parse failure → fall back
 *     to the human prompt (not auto-deny).
 *   - Input sanitisation: only pre-approved fields from toolInput are
 *     forwarded to the classifier — raw JSON is never passed through,
 *     preventing prompt injection via model-generated tool arguments.
 *   - Minimal context: only the last N message summaries + the current
 *     action are sent, keeping latency and cost low.
 */

import { callAnthropicMessages } from './anthropic-api.js'
import { createLogger } from './log.js'
import { config } from './config.js'

const log = createLogger('classifier')

/** When neither config nor session provides a model, the classifier
 *  cannot run — we return allow:false (fail-closed) and fall back to
 *  the human prompt. No hardcoded fallback model. */

// ── System Prompt ────────────────────────────────────────────────

const CLASSIFIER_SYSTEM_PROMPT = `You are a security classifier for a coding assistant running in a
web-based IDE. Your ONLY job is to evaluate whether a proposed tool
action is safe to execute WITHOUT human approval.

You will receive a recent conversation summary followed by a
"PROPOSED ACTION" block. Evaluate ONLY the proposed action.

## Block (output <block>yes</block>) if the action:
- Executes potentially destructive commands (rm -rf, DROP TABLE, format)
- Downloads and executes remote code (curl|sh, wget|bash, iex)
- Modifies system configuration (/etc/, registry, PATH, env vars)
- Accesses credentials or secrets (.env, .ssh, tokens, keys, passwords)
- Runs with elevated privileges (sudo, RunAs, -ExecutionPolicy Bypass)
- Makes irreversible network operations (git push --force, npm publish)
- Contains shell injection patterns (backticks, $(), ; | &&)
- Installs or removes global packages (npm -g, pip install --user)
- Modifies git hooks or CI/CD configuration

## Allow (output <block>no</block>) if the action:
- Reads files, searches code, lists directories
- Edits source code files within the project
- Runs standard dev tools (npm, pip, cargo, go, make, docker compose)
- Git operations within normal workflow (commit, branch, checkout, stash)
- Creates or modifies project files (not config files outside the project)
- Runs tests, linters, formatters, or build commands

## Output format:
Reply with EXACTLY ONE of:
<block>yes</block>
<block>no</block>
Do NOT output anything else. No explanation, no preamble.`

// ── Input Sanitisation ───────────────────────────────────────────

/** Fields we extract per tool. Unknown tools get an empty map — the
 *  classifier must decide from the tool name alone. */
const SAFE_FIELDS: Record<string, string[]> = {
  Bash: ['command'],
  PowerShell: ['command'],
  Edit: ['file_path', 'old_string', 'new_string'],
  Write: ['file_path'],
  FileRead: ['file_path'],
  Glob: ['pattern', 'path'],
  Grep: ['pattern', 'path', 'glob'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  NotebookEdit: ['notebook_path'],
  TaskCreate: ['subject'],
  TaskUpdate: ['subject'],
  SendMessage: ['message'],
}

/** Maximum length for any single field value. Prevents token explosion
 *  and reduces injection surface area. */
const MAX_FIELD_LENGTH = 500

/**
 * Extract only pre-approved fields from the raw toolInput object.
 * Unknown fields and non-string values are silently dropped.
 * Each value is truncated to MAX_FIELD_LENGTH.
 */
export function sanitizeToolInput(
  toolName: string,
  raw: unknown,
): Record<string, string> {
  if (typeof raw !== 'object' || raw === null) return {}
  const input = raw as Record<string, unknown>
  const cleaned: Record<string, string> = {}
  for (const field of SAFE_FIELDS[toolName] ?? []) {
    const val = input[field]
    if (typeof val === 'string') {
      cleaned[field] =
        val.length > MAX_FIELD_LENGTH
          ? val.slice(0, MAX_FIELD_LENGTH) + '…'
          : val
    }
  }
  return cleaned
}

// ── Action Serialisation ─────────────────────────────────────────

/** Turn sanitised toolInput into a single-line description. */
function formatAction(
  toolName: string,
  cleaned: Record<string, string>,
): string {
  const fields = Object.entries(cleaned)
  if (fields.length === 0) return toolName
  const pairs = fields.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
  return `${toolName} ${pairs}`
}

// ── XML Parsing ──────────────────────────────────────────────────

const BLOCK_RE = /<block>\s*(yes|no)\s*<\/block>/i

function parseBlockDecision(response: string): boolean | null {
  const match = BLOCK_RE.exec(response)
  if (!match) return null
  return match[1].toLowerCase() === 'yes'
}

// ── Classifier Result ────────────────────────────────────────────

export interface ClassifierResult {
  allow: boolean
  reason: string
}

// ── Main Entry Point ─────────────────────────────────────────────

/**
 * Classify a tool action as safe or unsafe.
 *
 * @returns `{ allow: true }` if the classifier says the action is safe,
 *          `{ allow: false }` if it should be blocked.
 *          On ANY failure the caller should fall back to the human prompt
 *          (this function itself never throws — it returns `allow: false`
 *          on errors to maintain fail-closed semantics).
 */
export async function classifyToolAction(params: {
  toolName: string
  toolInput: Record<string, string>
  messages: Array<{ role: string; content: string }>
  cwd: string
  signal?: AbortSignal
  /** The session's current model. Used as fallback when
   *  config.autoClassifierModel is empty/unset. */
  sessionModel?: string
}): Promise<ClassifierResult> {
  const { toolName, toolInput, messages, cwd, signal, sessionModel } = params

  // Abort check before spending tokens
  if (signal?.aborted) {
    return { allow: false, reason: 'Classifier aborted before start' }
  }

  // Build the user prompt: conversation summary + proposed action
  const parts: string[] = []

  if (messages.length > 0) {
    parts.push('## Recent conversation')
    for (const msg of messages) {
      const label = msg.role === 'user' ? 'User' : 'Assistant'
      const text =
        msg.content.length > 300
          ? msg.content.slice(0, 300) + '…'
          : msg.content
      parts.push(`${label}: ${text}`)
    }
    parts.push('')
  }

  parts.push(`## Working directory\n${cwd}\n`)
  parts.push(`## Proposed action\n${formatAction(toolName, toolInput)}`)

  const userPrompt = parts.join('\n')

  // Merge the caller's signal with our own timeout
  const timeoutMs = config.autoClassifierTimeout ?? 5_000
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const mergedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal

  try {
    // Priority: config override > session model > fail-closed
    const model = config.autoClassifierModel || sessionModel
    if (!model) {
      return { allow: false, reason: 'No classifier model configured and session has no model' }
    }
    const startMs = Date.now()

    const response = await callAnthropicMessages({
      model,
      system: CLASSIFIER_SYSTEM_PROMPT,
      userContent: userPrompt,
      maxTokens: 32,
      temperature: 0,
      signal: mergedSignal,
    })

    const elapsed = Date.now() - startMs
    const block = parseBlockDecision(response)

    if (block === null) {
      log.warn(
        `Classifier returned unparseable response (${elapsed}ms): ` +
          response.slice(0, 200),
      )
      return { allow: false, reason: 'Classifier response unparseable' }
    }

    log.info(
      `Classified ${toolName}: ${block ? 'BLOCK' : 'ALLOW'} (${elapsed}ms)`,
    )
    return {
      allow: !block,
      reason: block ? 'Classifier flagged as unsafe' : 'Classifier approved',
    }
  } catch (err: unknown) {
    // Fail-closed: any error → fall back to human prompt
    if (mergedSignal.aborted) {
      const isCallerAbort = signal?.aborted === true
      log.warn(
        `Classifier ${isCallerAbort ? 'aborted by caller' : 'timed out'} for ${toolName}`,
      )
      return {
        allow: false,
        reason: isCallerAbort
          ? 'Classifier aborted'
          : 'Classifier timeout',
      }
    }

    const msg = err instanceof Error ? err.message : String(err)
    log.warn(`Classifier error for ${toolName}: ${msg}`)
    return { allow: false, reason: `Classifier error: ${msg}` }
  }
}
