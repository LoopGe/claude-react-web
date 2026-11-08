// server/providers/native/sse.ts
/** Minimal Anthropic SSE parser: yields `{ event, data }` pairs from a byte
 *  stream. Handles CRLF, comment lines, and events split across chunks. */
export interface SseEvent {
  event: string
  data: unknown
}

export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let idx: number
    while ((idx = buffer.search(/\r?\n/)) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 2 : 1))
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      else if (line === '') {
        if (dataLines.length > 0) {
          const raw = dataLines.join('\n')
          let data: unknown
          try {
            data = JSON.parse(raw)
          } catch {
            throw new Error('invalid sse data')
          }
          yield { event: eventName, data }
        }
        eventName = ''
        dataLines = []
      }
    }
  }
}
