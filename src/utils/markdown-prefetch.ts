// Early start for the on-demand highlight.js grammars (lowlight-instance.ts):
// request a grammar as soon as content that needs it is SEEN (a live frame, a
// streamed delta, a replay burst, cached history) instead of when a row first
// renders it. The load then usually lands before the row mounts, so its first
// paint is already highlighted.
//
// Best-effort and deliberately over-eager: a false positive only loads a
// small chunk early. Correctness never depends on this module; the render
// path (compileMarkdown, highlightLineHast) requests whatever it needs itself.

import { allGrammarsRegistered, lazyGrammarFor, requestGrammar } from './lowlight-instance'
import { detectLanguage } from './file-display'

/** A fence opener's info word. Not anchored to a line start (list and quote
 *  prefixes vary); an extra match only prefetches. */
const FENCE_INFO_RE = /(?:`{3,}|~{3,})[ \t]*([^\s`~]+)/g
/** Tools whose cards render a syntax-highlighted diff of their file. */
const DIFF_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
/** How much of a session's previous text delta is kept, so a fence whose info
 *  string straddles two deltas ("```sw" + "ift") is still read whole. */
const STREAM_TAIL = 32

const streamTails = new Map<string, string>()
const scanned = new WeakSet<object>()

function requestForTag(tag: string): void {
  const grammar = lazyGrammarFor(tag)
  if (grammar) void requestGrammar(grammar)
}

/** Text that renders through <Markdown>. */
export function prefetchMarkdownText(text: string): void {
  if (!text.includes('```') && !text.includes('~~~')) return
  for (const match of text.matchAll(FENCE_INFO_RE)) requestForTag(match[1])
}

interface BlockLike {
  type?: unknown
  text?: unknown
  name?: unknown
  input?: { file_path?: unknown; notebook_path?: unknown }
}

interface MessageLike {
  type?: unknown
  message?: { content?: unknown }
  event?: { delta?: { type?: unknown; text?: unknown } }
}

function scanMessage(message: MessageLike, streamKey: string): void {
  if (message.type === 'stream_event') {
    const delta = message.event?.delta
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      const text = (streamTails.get(streamKey) ?? '') + delta.text
      streamTails.set(streamKey, text.slice(-STREAM_TAIL))
      prefetchMarkdownText(text)
    }
    return
  }
  const content = message.message?.content
  if (typeof content === 'string') {
    prefetchMarkdownText(content)
    return
  }
  if (!Array.isArray(content)) return
  for (const block of content as BlockLike[]) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      prefetchMarkdownText(block.text)
    } else if (block?.type === 'tool_use' && typeof block.name === 'string' && DIFF_TOOLS.has(block.name)) {
      const path = block.input?.file_path ?? block.input?.notebook_path
      const lang = typeof path === 'string' ? detectLanguage(path) : null
      if (lang) requestForTag(lang)
    }
  }
}

/**
 * Scan one SDK message (a live frame, a replay entry, a cached one) for the
 * grammars its rendering will need. A message object is scanned once; stream
 * deltas are scanned per delta with the previous one's tail, keyed by
 * `streamKey` (the session id). Never throws: a malformed frame must not break
 * ingestion.
 */
export function prefetchMarkdownFeatures(message: unknown, streamKey = ''): void {
  if (!message || typeof message !== 'object' || allGrammarsRegistered()) return
  const msg = message as MessageLike
  if (msg.type !== 'stream_event') {
    if (scanned.has(msg)) return
    scanned.add(msg)
  }
  try {
    scanMessage(msg, streamKey)
  } catch {
    // Best-effort; the render path still requests whatever it needs.
  }
}

export function prefetchMarkdownFeaturesForMessages(messages: readonly unknown[]): void {
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (allGrammarsRegistered()) return
    prefetchMarkdownFeatures(message)
  }
}

/** A transcript's items, cached history included (each message is scanned
 *  once, so re-running this on every items change stays cheap). */
export function prefetchMarkdownFeaturesForItems(items: readonly { msg: unknown }[]): void {
  for (const item of items) {
    if (allGrammarsRegistered()) return
    prefetchMarkdownFeatures(item.msg)
  }
}
