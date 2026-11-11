// Test-only transport for the native web tools.
//
// Tests mock `node:https` / `node:http` `request` with `fakeRequest` and answer
// page requests with a Fetch `Response` through `setFakeWebHandler`. The real
// `Agent` classes stay in place, so a request's `agent.options.lookup` is the
// production connection-time DNS gate and can be asserted directly. Nothing in
// this module is imported by production code.
import { EventEmitter } from 'node:events'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { RequestOptions } from 'node:https'

export interface FakeWebCall {
  url: string
  headers: Record<string, string>
  signal?: AbortSignal
  /** The Agent the production transport passed, for lookup-wiring assertions. */
  agent?: unknown
}

export type FakeWebHandler = (url: string) => Response | Promise<Response>

const defaultHandler: FakeWebHandler = () => new Response('no fake transport handler', { status: 500 })
let handler: FakeWebHandler = defaultHandler
const calls: FakeWebCall[] = []

export function setFakeWebHandler(next: FakeWebHandler): void {
  handler = next
}

export function fakeWebCalls(): readonly FakeWebCall[] {
  return calls
}

export function resetFakeWebTransport(): void {
  handler = defaultHandler
  calls.length = 0
}

class FakeIncomingMessage extends EventEmitter {
  readonly statusCode: number
  readonly statusMessage: string
  readonly headers: Record<string, string>
  private readonly response: Response
  private destroyed = false

  constructor(response: Response) {
    super()
    this.response = response
    this.statusCode = response.status
    this.statusMessage = response.statusText
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value })
    this.headers = headers
  }

  destroy(): void {
    this.destroyed = true
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    if (!this.response.body) return
    const reader = this.response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (this.destroyed) {
        await reader.cancel().catch(() => {})
        return
      }
      if (done) return
      if (value) yield value
    }
  }
}

class FakeClientRequest extends EventEmitter {
  constructor(
    private readonly url: string,
    private readonly options: RequestOptions,
    private readonly onResponse: (res: IncomingMessage) => void,
  ) {
    super()
  }

  setTimeout(): this {
    return this
  }

  write(): boolean {
    return true
  }

  end(): this {
    const signal = this.options.signal ?? undefined
    queueMicrotask(() => {
      if (signal?.aborted) {
        this.emit('error', new DOMException('The operation was aborted', 'AbortError'))
        return
      }
      calls.push({
        url: this.url,
        headers: headerRecord(this.options.headers),
        signal,
        agent: this.options.agent,
      })
      void Promise.resolve(handler(this.url)).then(
        (response) => this.onResponse(new FakeIncomingMessage(response) as unknown as IncomingMessage),
        (err: unknown) => this.emit('error', err),
      )
    })
    return this
  }

  destroy(err?: Error): this {
    if (err) this.emit('error', err)
    return this
  }
}

function headerRecord(headers: RequestOptions['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return out
}

/** Drop-in replacement for `https.request(url, options, callback)` used by the
 *  module factories in tests. Only the shape the web transport calls is
 *  implemented. */
export function fakeRequest(
  input: URL | string,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void,
): ClientRequest {
  const url = input instanceof URL ? input.href : String(input)
  return new FakeClientRequest(url, options, callback) as unknown as ClientRequest
}