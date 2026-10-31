import { describe, it, expect, vi, beforeEach } from 'vitest'

// `plainText` must not run the unified markdown pipeline at ingest.
//
// `toTranscriptItem` is called once per durable message on the live append
// path (updateTranscriptMirror) and once per message of every REST history
// page (windowPage). Computing `plainText` eagerly meant every one of those
// paid `extractMessagePlainText` — a full remark parse per text block:
// measured 0.12 ms (short user prompt) / 0.94 ms (~40-line assistant reply)
// / 19.3 ms (~500-line code-heavy reply). A 200-message page cost ~0.5 s of
// synchronous main-thread work, up to 3.8 s when code-dense.
//
// Nothing reads the value until in-session search runs or a prompt-signature
// dedup scans a user prompt, so ingest must stay free and the value must be
// derived on first read instead.
//
// `toTranscriptItem` no longer takes a `cachedPlainText` parameter — that
// compatibility shim (written for the removed v3 localStorage/IndexedDB
// transcript cache) had no production caller. The lazy memo contract it
// expressed is now proven directly: a memoized `null` skips extraction and
// an `undefined` memo recomputes. `topLevelUserPromptSignature` BELOW keeps
// its own cached-plaintext parameter (it has a live two-argument caller in
// the reducer that passes a TranscriptItem's already-computed `plainText`).

vi.mock('../search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../search')>()
  return {
    ...actual,
    extractMessagePlainText: vi.fn(actual.extractMessagePlainText),
  }
})

import { extractMessagePlainText } from '../search'
import { toTranscriptItem, topLevelUserPromptSignature } from './normalize'
// Compile-time type-ownership check: `ActiveWorktree` is now DEFINED and
// exported from `types.ts` (moved out of `normalize.ts` to break the
// type-only `types ↔ normalize` import cycle). If the interface is still
// only in `normalize.ts`, this import fails typecheck.
import type { ActiveWorktree } from './types'
import type { SdkMessage } from '../types'

const mockedExtract = vi.mocked(extractMessagePlainText)

function assistant(text: string): SdkMessage {
  return {
    type: 'assistant',
    uuid: 'u-' + Math.random().toString(36).slice(2),
    message: { content: [{ type: 'text', text }] },
  } as unknown as SdkMessage
}

/** A top-level user prompt (parent_tool_use_id null, string content). */
function userPrompt(text: string): SdkMessage {
  return {
    type: 'user',
    uuid: 'u-' + Math.random().toString(36).slice(2),
    message: { content: text },
  } as unknown as SdkMessage
}

/** An image-only user message — `extractMessagePlainText` returns null for it
 *  (no text / tool_result block), which is what proves the memoized-null leg. */
function imageOnlyUser(): SdkMessage {
  return {
    type: 'user',
    uuid: 'u-' + Math.random().toString(36).slice(2),
    message: { content: [{ type: 'image', source: { type: 'base64' } }] },
  } as unknown as SdkMessage
}

describe('ActiveWorktree type ownership', () => {
  it('is defined and exported from types.ts (not normalize.ts)', () => {
    // Compile-time check: `ActiveWorktree` must be importable from `./types`.
    // If the interface is still only defined in `normalize.ts` (not moved
    // here), the import at the top of this file fails typecheck. The
    // annotation below additionally pins the two-field shape so an accidental
    // field change surfaces here too.
    const aw: ActiveWorktree = { name: 'owner-check', enterMsgId: 'm1' }
    expect(aw).toEqual({ name: 'owner-check', enterMsgId: 'm1' })
  })
})

describe('toTranscriptItem keeps plainText lazy', () => {
  beforeEach(() => {
    mockedExtract.mockClear()
  })

  it('does not touch the markdown pipeline when the item is built', () => {
    const item = toTranscriptItem(assistant('Hello **world**\n\n```js\n1\n```'), undefined)
    expect(item).not.toBeNull()
    expect(
      mockedExtract,
      'ingest must not run extractMessagePlainText — it is the whole point of the lazy getter',
    ).not.toHaveBeenCalled()
  })

  it('derives plainText on first read, and only once (undefined memo recomputes)', () => {
    const msg = assistant('Hello **world**')
    const item = toTranscriptItem(msg, undefined)!
    expect(mockedExtract).not.toHaveBeenCalled()

    const first = item.plainText
    expect(mockedExtract).toHaveBeenCalledTimes(1)
    expect(first).toContain('Hello world')

    // Memoised: a second read must not re-parse.
    const second = item.plainText
    expect(mockedExtract).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('memoizes a null extraction and skips the pipeline on later reads', () => {
    // An image-only user message has no extractable text, so the pipeline
    // returns null. A memoized null must short-circuit subsequent reads the
    // same way a memoized string does — this is the contract the deleted
    // `cachedPlainText: null` parameter used to express at the call site.
    const msg = imageOnlyUser()
    const item = toTranscriptItem(msg, undefined)!
    expect(mockedExtract).not.toHaveBeenCalled()

    const first = item.plainText
    expect(first).toBeNull()
    expect(mockedExtract).toHaveBeenCalledTimes(1)

    // The memoized null skips re-extraction on the next read.
    const second = item.plainText
    expect(second).toBeNull()
    expect(mockedExtract).toHaveBeenCalledTimes(1)
  })

  it('a page of messages costs no parse work at build time', () => {
    const built = Array.from({ length: 200 }, (_, i) =>
      toTranscriptItem(assistant('## Heading\n\n```py\nprint(' + i + ')\n```'), undefined),
    )
    expect(built).toHaveLength(200)
    expect(mockedExtract).not.toHaveBeenCalled()
  })

  it('accepts exactly two arguments (the third cachedPlainText parameter was deleted)', () => {
    // Compile-time assertion. The legacy `cachedPlainText` parameter was
    // removed from `toTranscriptItem`, so passing a third argument is now a
    // type error. `@ts-expect-error` suppresses it; if the parameter still
    // existed the directive itself would error ("Unused '@ts-expect-error'
    // directive"), failing typecheck — which is exactly how this locks the
    // two-argument signature in.
    // @ts-expect-error toTranscriptItem accepts exactly two arguments now
    const item = toTranscriptItem(assistant('x'), undefined, 'legacy-cache')
    expect(item).not.toBeNull()
  })
})

describe('topLevelUserPromptSignature keeps its cached plaintext parameter', () => {
  beforeEach(() => {
    mockedExtract.mockClear()
  })

  it('honours a cached plaintext string and skips extraction', () => {
    const msg = userPrompt('Hello **world**')
    const sig = topLevelUserPromptSignature(msg, 'from-cache')
    expect(sig).toBe('from-cache')
    expect(mockedExtract).not.toHaveBeenCalled()
  })

  it('treats a cached null as an empty signature and skips extraction', () => {
    const msg = userPrompt('ignored')
    const sig = topLevelUserPromptSignature(msg, null)
    expect(sig).toBe('')
    expect(mockedExtract).not.toHaveBeenCalled()
  })

  it('recomputes via the pipeline when no cache is supplied (undefined)', () => {
    const msg = userPrompt('Hello **world**')
    const sig = topLevelUserPromptSignature(msg)
    expect(sig).toBe('Hello world')
    expect(mockedExtract).toHaveBeenCalledTimes(1)
  })
})
