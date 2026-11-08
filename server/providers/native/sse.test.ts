// server/providers/native/sse.test.ts
import { describe, expect, it } from 'vitest'
import { parseSseStream } from './sse.js'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>) {
  const out: Array<{ event: string; data: unknown }> = []
  for await (const ev of parseSseStream(body)) out.push(ev)
  return out
}

describe('parseSseStream', () => {
  it('parses event/data pairs across chunk boundaries', async () => {
    const events = await collect(streamOf([
      'event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_',
      'delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
    ]))
    expect(events).toEqual([
      { event: 'message_start', data: { type: 'message_start' } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } },
    ])
  })

  it('skips comments, CRLF line endings and [DONE]-style empty data', async () => {
    const events = await collect(streamOf([': keep-alive\r\n\r\nevent: ping\r\ndata: {}\r\n\r\n']))
    expect(events).toEqual([{ event: 'ping', data: {} }])
  })

  it('throws on a non-JSON data line', async () => {
    await expect(collect(streamOf(['event: x\ndata: not-json\n\n']))).rejects.toThrow('invalid sse data')
  })
})
