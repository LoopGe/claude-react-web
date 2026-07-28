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
 *  into `target`. The LLM is asked to return the translation on the first
 *  line and the source language on the second — simpler + faster than
 *  asking for JSON (less output tokens, no format "thinking"). Does NOT
 *  hardcode a model — the host's defaultModel is used (configurable per
 *  user via the optional `model` setting in the plugin config). */
export function buildPrompt(target, text, model) {
  const name = targetName(target)
  const system =
    `Translate into ${name}. Respond with JSON: {"translation":"<translated text>","source":"<source language name>"}. No markdown, no code fences.`
  const params = {
    purpose: 'translation',
    system,
    messages: [{ role: 'user', content: text }],
    maxTokens: 1024,
  }
  if (model) params.model = model
  return params
}

/** Parse the LLM's response into {translation, source}. The prompt asks for
 *  JSON: {"translation":"...","source":"..."}. Strips code fences, extracts
 *  the first {...} object (in case the LLM adds surrounding text), then
 *  JSON.parse. Degrades to {translation: <raw>, source: 'unknown'} if
 *  parsing fails so the user still sees something. */
export function parseTranslation(content) {
  const raw = typeof content === 'string' ? content : String(content ?? '')
  let text = raw.trim()
  // Strip ```json ... ``` or ``` ... ``` fences.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  // Try direct parse first.
  try {
    return extractFromJson(text, raw)
  } catch { /* not pure JSON */ }
  // If that fails, try to extract the first {...} block (LLM may add
  // surrounding text like "Here is the translation: {...}").
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      return extractFromJson(text.slice(start, end + 1), raw)
    } catch { /* not valid JSON either */ }
  }
  // Degrade: treat the whole response as the translation.
  return { translation: raw.trim(), source: 'unknown' }
}

function extractFromJson(jsonStr, raw) {
  const obj = JSON.parse(jsonStr)
  return {
    translation: typeof obj.translation === 'string' ? obj.translation : raw.trim(),
    source: typeof obj.source === 'string' && obj.source ? obj.source : 'unknown',
  }
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
export async function translate({ invocationId, text, target, useCache, model, callHost }) {
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
    const res = await callHost('ai.request', buildPrompt(tgt, text, model))
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
