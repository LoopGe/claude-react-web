// Pure, unit-testable translation helpers for the Translate plugin.
//
// Kept separate from service.mjs (the JSON-RPC child loop) so the prompt
// construction + result parsing can be tested directly. No Host API, no I/O.

import { createHash } from 'node:crypto'

const TARGET_NAMES = {
  'zh-CN': 'Simplified Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  ru: 'Russian',
  ar: 'Arabic',
  pt: 'Portuguese',
}

/** Human-readable target name for the enum value (falls back to the code). */
export function targetName(target) {
  return TARGET_NAMES[target] ?? target
}

/** Build the ai.request params (system + messages) for translating `text`
 *  into `target`. The LLM is asked to return compact JSON so we can extract
 *  the translation + detected source language. */
export function buildPrompt(target, text) {
  const name = targetName(target)
  const system =
    `You are a translation assistant. Translate the user's text into ${name}. ` +
    `Detect the source language. Respond ONLY with compact JSON: ` +
    `{"translation":"<translated text>","source":"<source language name>"}. ` +
    `If the text is already in ${name}, set translation to the original text and still name the source. ` +
    `Do not add commentary, markdown, or code fences.`
  return {
    purpose: 'translation',
    system,
    messages: [{ role: 'user', content: text }],
  }
}

/** Parse the LLM's response into {translation, source}. Tolerant:
 *  - strips code fences if present;
 *  - extracts the first {...} JSON object;
 *  - degrades to {translation: <raw text>, source: 'unknown'} on any failure
 *    so the user still sees something rather than an error. */
export function parseTranslation(content) {
  const raw = typeof content === 'string' ? content : String(content ?? '')
  const json = extractJson(raw)
  if (json) {
    const translation = typeof json.translation === 'string' ? json.translation : raw.trim()
    const source = typeof json.source === 'string' && json.source ? json.source : 'unknown'
    return { translation, source }
  }
  // Degrade: the whole response is the translation; source unknown.
  return { translation: raw.trim(), source: 'unknown' }
}

/** Pull the first balanced {...} JSON object out of `s` (after stripping
 *  ```json fences). String-aware: skips over quoted strings so a `}` inside
 *  a JSON string value (e.g. {"translation":"a}b"}) doesn't fool the brace
 *  counter. Returns null if none / unparseable. */
function extractJson(s) {
  let text = s.trim()
  // Strip a leading code fence (```json ... ``` or ``` ... ```).
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const candidate = text.slice(start, i + 1)
        try {
          return JSON.parse(candidate)
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** Stable cache key for a (text, target) pair. sha256 eliminates the
 *  collision class a 32-bit hash would have (a wrong cached translation on
 *  collision). node:crypto is available in the subprocess + the test env. */
export function cacheKey(text, target) {
  const h = createHash('sha256').update(`${target}\0${text}`).digest('hex').slice(0, 32)
  return `t:${h}`
}

/** Build the Popover result from a parsed translation. */
export function toPopover(invocationId, { translation, source }) {
  return {
    type: 'popover',
    invocationId,
    title: 'Translate',
    content: { kind: 'markdown', markdown: `**${translation}**\n\n_Source: ${source}_` },
  }
}

/** The full translate flow, with `callHost` injected so it's testable without
 *  a subprocess or real LLM credentials. Returns a PluginCommandResult
 *  (popover on success / cache hit; notification on ai failure). */
export async function translate({ invocationId, text, target, useCache, callHost }) {
  const tgt = target || 'zh-CN'
  const key = cacheKey(text, tgt)

  // Cache hit → return immediately.
  if (useCache && text) {
    try {
      const got = await callHost('storage.get', { scope: 'global', key })
      if (got && got.found !== false && got.value) {
        return toPopover(invocationId, got.value)
      }
    } catch {
      /* cache read failure → fall through to a fresh translation */
    }
  }

  // Translate via the host's LLM.
  let content
  try {
    const res = await callHost('ai.request', { ...buildPrompt(tgt, text), maxTokens: 1024 })
    content = res?.content ?? ''
  } catch (e) {
    return {
      type: 'notification',
      invocationId,
      level: 'error',
      title: 'Translate',
      content: { kind: 'text', text: `Translation failed: ${e.message}` },
    }
  }

  const parsed = parseTranslation(content)

  // Cache the result (best-effort).
  if (useCache && text) {
    try {
      await callHost('storage.set', { scope: 'global', key, value: parsed })
    } catch {
      /* cache write failure → non-fatal */
    }
  }

  return toPopover(invocationId, parsed)
}

