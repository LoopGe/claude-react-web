import { createLogger } from '../../log.js'
import type { NativeModelDiscovery, NativeModelRoute } from './model-context.js'

const DISCOVERY_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 64 * 1024
const log = createLogger('native-model-discovery')

class DiscoveryFailure extends Error {}

function diagnosticBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return '<invalid-url>'
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) throw new DiscoveryFailure('Anthropic model discovery returned an empty body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (total + next.value.byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new DiscoveryFailure('Anthropic model discovery response exceeded 64 KiB')
      }
      chunks.push(next.value)
      total += next.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export class AnthropicModelDiscovery implements NativeModelDiscovery {
  private readonly fetchFn: typeof fetch

  constructor(opts: { fetchFn?: typeof fetch } = {}) {
    this.fetchFn = opts.fetchFn ?? fetch
  }

  async retrieve(route: NativeModelRoute): Promise<number | undefined> {
    const controller = new AbortController()
    const baseUrl = diagnosticBaseUrl(route.baseUrl)
    let rejectDeadline!: (reason: DiscoveryFailure) => void
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject
    })
    const timeout = setTimeout(() => {
      controller.abort()
      rejectDeadline(new DiscoveryFailure('Anthropic model discovery timed out'))
    }, DISCOVERY_TIMEOUT_MS)
    timeout.unref()
    try {
      return await Promise.race([this.request(route, controller.signal), deadline])
    } catch (error) {
      if (controller.signal.aborted) {
        log.debug(`provider=${route.providerId} baseUrl=${baseUrl} model=${route.model} source=fallback reason=timeout`)
        throw new DiscoveryFailure('Anthropic model discovery timed out')
      }
      if (error instanceof DiscoveryFailure) {
        log.debug(`provider=${route.providerId} baseUrl=${baseUrl} model=${route.model} source=fallback reason=${error.message}`)
        throw error
      }
      log.debug(`provider=${route.providerId} baseUrl=${baseUrl} model=${route.model} source=fallback reason=request-error`)
      throw new DiscoveryFailure('Anthropic model discovery request failed')
    } finally {
      clearTimeout(timeout)
    }
  }

  private async request(route: NativeModelRoute, signal: AbortSignal): Promise<number | undefined> {
    const { authToken } = route.credentials()
    if (!authToken) throw new DiscoveryFailure('Anthropic model discovery credentials are unavailable')
    const response = await this.fetchFn(`${route.baseUrl}/v1/models/${encodeURIComponent(route.model)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'anthropic-version': '2023-06-01',
      },
      redirect: 'error',
      signal,
    })
    if (!response.ok) {
      if (response.body) void response.body.cancel().catch(() => undefined)
      throw new DiscoveryFailure(`Anthropic model discovery returned HTTP ${response.status}`)
    }
    const text = await readBoundedBody(response)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new DiscoveryFailure('Anthropic model discovery returned invalid JSON')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
    const model = body as Record<string, unknown>
    if ('id' in model && model.id !== route.model) return undefined
    const contextWindow = model.max_input_tokens
    return typeof contextWindow === 'number' && Number.isSafeInteger(contextWindow) && contextWindow > 0
      ? contextWindow
      : undefined
  }
}
