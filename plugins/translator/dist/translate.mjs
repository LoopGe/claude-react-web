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
    `Translate into ${name}. First line: the source language name. Everything after the first line: the translation. Nothing else.`
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
 *  the source language name on the first line, and the translation on all
 *  subsequent lines (so multi-line translations aren't truncated).
 *  Tolerant — degrades gracefully if the format isn't followed. */
export function parseTranslation(content) {
  const raw = typeof content === 'string' ? content : String(content ?? '')
  const trimmed = raw.trim()
  const nlIdx = trimmed.indexOf('\n')
  if (nlIdx === -1) {
    // Single line — treat the whole thing as the translation.
    return { translation: trimmed, source: 'unknown' }
  }
  const source = trimmed.slice(0, nlIdx).trim()
  const translation = trimmed.slice(nlIdx + 1).trim()
  return { translation: translation || trimmed, source: source || 'unknown' }
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
