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

vi.mock('../search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../search')>()
  return {
    ...actual,
    extractMessagePlainText: vi.fn(actual.extractMessagePlainText),
  }
})

import { extractMessagePlainText } from '../search'
import { toTranscriptItem } from './normalize'
import type { SdkMessage } from '../types'

const mockedExtract = vi.mocked(extractMessagePlainText)

function assistant(text: string): SdkMessage {
  return {
    type: 'assistant',
    uuid: 'u-' + Math.random().toString(36).slice(2),
    message: { content: [{ type: 'text', text }] },
  } as unknown as SdkMessage
}

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

  it('derives plainText on first read, and only once', () => {
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

  it('still honours cachedPlainText instead of re-parsing', () => {
    const item = toTranscriptItem(assistant('ignored'), undefined, 'from-cache')!
    expect(item.plainText).toBe('from-cache')
    expect(mockedExtract).not.toHaveBeenCalled()
  })

  it('treats a stored null as "no extractable text" and skips the pipeline', () => {
    const item = toTranscriptItem(assistant('ignored'), undefined, null)!
    expect(item.plainText).toBeNull()
    expect(mockedExtract).not.toHaveBeenCalled()
  })

  it('a page of messages costs no parse work at build time', () => {
    const built = Array.from({ length: 200 }, (_, i) =>
      toTranscriptItem(assistant('## Heading\n\n```py\nprint(' + i + ')\n```'), undefined),
    )
    expect(built).toHaveLength(200)
    expect(mockedExtract).not.toHaveBeenCalled()
  })
})
