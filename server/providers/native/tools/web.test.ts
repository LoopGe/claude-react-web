// server/providers/native/tools/web.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderProfile } from '../../../config.js'
import { ToolInputError, type ToolContext } from './types.js'
import { htmlToText, isNonPublicIp } from './web.js'
import { createWebFetchTool, WEB_FETCH_GUIDANCE } from './web-fetch.js'
import { parseDuckDuckGoResults, webSearchTool } from './web-search.js'

// Every request in this file is answered by the stubbed global `fetch`; DNS is
// stubbed too so a hostname never leaves the process.
const lookupMock = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }))

const PUBLIC_ADDRESS = [{ address: '93.184.216.34', family: 4 }]

function ctx(signal?: AbortSignal): ToolContext {
  return { cwd: process.cwd(), signal: signal ?? new AbortController().signal }
}

function parse<T>(text: string): T {
  return JSON.parse(text) as T
}

function htmlResponse(html: string, init: ResponseInit = {}): Response {
  return new Response(html, {
    ...init,
    headers: { 'content-type': 'text/html; charset=utf-8', ...(init.headers ?? {}) },
  })
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } })
}

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'p1',
    name: 'Profile 1',
    authToken: 'tok',
    baseUrl: 'https://api.example.test',
    modelList: [],
    modelGroups: [],
    recapModel: '',
    commitMessageModel: '',
    ...overrides,
  }
}

const PAGE_HTML =
  '<html><head><title>T</title><style>.a{}</style></head><body><h1>Hello</h1><script>evil()</script><p>World</p></body></html>'

type FetchMock = ReturnType<typeof vi.fn>

let fetchMock: FetchMock

function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): FetchMock {
  fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    return handler(String(input), init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Route the auxiliary Anthropic call to a canned answer and every other
 *  request to `page`. */
function stubPage(page: () => Response, answer = 'ANSWER'): FetchMock {
  return stubFetch((url) => {
    if (url.endsWith('/v1/messages')) {
      return jsonResponse({ content: [{ type: 'text', text: answer }] })
    }
    return page()
  })
}

function auxRequest(mock: FetchMock): { url: string; body: Record<string, unknown>; init: RequestInit } {
  const call = mock.mock.calls.find(([url]) => String(url).endsWith('/v1/messages'))
  if (!call) throw new Error('no auxiliary request was made')
  return {
    url: String(call[0]),
    init: call[1] as RequestInit,
    body: JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>,
  }
}

beforeEach(() => {
  lookupMock.mockReset()
  lookupMock.mockResolvedValue(PUBLIC_ADDRESS)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function webFetch(deps?: {
  model?: () => string
  profile?: ProviderProfile
  credentials?: () => { baseUrl: string; authToken: string }
}) {
  return createWebFetchTool({
    model: deps?.model ?? (() => 'session-model'),
    profile: deps?.profile ?? profile(),
    credentials: deps?.credentials ?? (() => ({ baseUrl: 'https://api.example.test', authToken: 'tok' })),
  })
}

describe('htmlToText', () => {
  it('strips script/style bodies and tags and collapses whitespace', () => {
    const text = htmlToText(
      '<html><head><style>.x { color: red }</style></head><body>\n  <h1>Hello</h1>\n  <script>evil()</script><p>there&nbsp;&amp;  <b>you</b></p></body></html>',
    )
    expect(text).toBe('Hello there & you')
    expect(text).not.toContain('evil()')
    expect(text).not.toContain('color: red')
  })

  it('decodes numeric entities', () => {
    expect(htmlToText('<p>&#65;&#x42;</p>')).toBe('AB')
  })
})

describe('isNonPublicIp', () => {
  it('classifies the documented non-public IPv4 ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '224.0.0.1']) {
      expect(isNonPublicIp(ip), ip).toBe(true)
    }
    for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1']) {
      expect(isNonPublicIp(ip), ip).toBe(false)
    }
  })

  it('classifies non-public IPv6 ranges, including IPv4-mapped forms', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
      expect(isNonPublicIp(ip), ip).toBe(true)
    }
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
      expect(isNonPublicIp(ip), ip).toBe(false)
    }
  })
})

describe('createWebFetchTool', () => {
  it('fetches the page, applies the prompt over its text, and returns the aux answer', async () => {
    stubPage(() => htmlResponse(PAGE_HTML))
    const tool = webFetch()
    const out = parse<Record<string, unknown>>((await tool.run({ url: 'https://docs.example.test/page', prompt: 'Summarize' }, ctx())).text)

    expect(out.result).toBe('ANSWER')
    expect(out.code).toBe(200)
    expect(out.url).toBe('https://docs.example.test/page')
    expect(out.bytes).toBeGreaterThan(0)
    expect(typeof out.durationMs).toBe('number')

    const aux = auxRequest(fetchMock)
    expect(aux.body.model).toBe('session-model')
    expect(aux.body.temperature).toBe(0.2)
    expect(aux.body.max_tokens).toBe(1024)
    expect(aux.body.system).toContain('Hello')
    expect(aux.body.system).toContain('World')
    expect(aux.body.system).not.toContain('evil()')
    expect((aux.body.messages as Array<{ content: string }>)[0].content).toBe('Summarize')
    expect((aux.init.headers as Record<string, string>).Authorization).toBe('Bearer tok')

    // The page request itself used manual redirect handling and a browser UA.
    const pageCall = fetchMock.mock.calls.find(([url]) => String(url).includes('docs.example.test'))!
    const pageInit = pageCall[1] as RequestInit
    expect(pageInit.redirect).toBe('manual')
    expect((pageInit.headers as Record<string, string>)['user-agent']).toContain('Mozilla')
  })

  it('prefers the profile recap model for the auxiliary call', async () => {
    stubPage(() => htmlResponse(PAGE_HTML))
    const tool = webFetch({ profile: profile({ recapModel: 'recap-model' }) })
    await tool.run({ url: 'https://docs.example.test/page', prompt: 'q' }, ctx())
    expect(auxRequest(fetchMock).body.model).toBe('recap-model')
  })

  it('slices the decoded text at offset before the auxiliary call', async () => {
    stubPage(() => htmlResponse('<p>0123456789</p>'))
    const tool = webFetch()
    await tool.run({ url: 'https://docs.example.test/page', prompt: 'q', offset: 4 }, ctx())
    expect(auxRequest(fetchMock).body.system).toBe('456789')
  })

  it('rejects a non-HTTP URL without touching the network', async () => {
    stubFetch(() => {
      throw new Error('fetch must not run')
    })
    await expect(webFetch().run({ url: 'ftp://example.test/file', prompt: 'q' }, ctx())).rejects.toThrow(
      /only HTTP\(S\) URLs/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a URL with embedded credentials without touching the network', async () => {
    stubFetch(() => {
      throw new Error('fetch must not run')
    })
    await expect(
      webFetch().run({ url: 'https://user:pass@example.test/page', prompt: 'q' }, ctx()),
    ).rejects.toThrow(/embedded credentials/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a URL longer than 2048 characters', async () => {
    stubFetch(() => {
      throw new Error('fetch must not run')
    })
    const url = `https://example.test/${'a'.repeat(2048)}`
    await expect(webFetch().run({ url, prompt: 'q' }, ctx())).rejects.toThrow(/exceeds 2048/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks private IP literals before connecting', async () => {
    stubFetch(() => {
      throw new Error('fetch must not run')
    })
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/']) {
      await expect(webFetch().run({ url, prompt: 'q' }, ctx()), url).rejects.toThrow(
        /blocked non-public address/,
      )
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks a hostname that resolves to a private address', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }])
    stubFetch(() => {
      throw new Error('fetch must not run')
    })
    await expect(
      webFetch().run({ url: 'https://internal.example.test/', prompt: 'q' }, ctx()),
    ).rejects.toThrow(/blocked non-public address 10\.0\.0\.5/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a cross-origin redirect', async () => {
    stubFetch((url) => {
      if (url === 'https://a.example.test/start') return redirect('https://b.example.test/other')
      return htmlResponse(PAGE_HTML)
    })
    await expect(
      webFetch().run({ url: 'https://a.example.test/start', prompt: 'q' }, ctx()),
    ).rejects.toThrow(/cross-origin redirect rejected/)
  })

  it('follows and re-validates a same-origin redirect', async () => {
    stubFetch((url) => {
      if (url === 'https://a.example.test/start') return redirect('/final')
      if (url === 'https://a.example.test/final') return htmlResponse(PAGE_HTML)
      if (url.endsWith('/v1/messages')) return jsonResponse({ content: [{ type: 'text', text: 'OK' }] })
      throw new Error(`unexpected url ${url}`)
    })
    const out = parse<{ url: string }>((await webFetch().run({ url: 'https://a.example.test/start', prompt: 'q' }, ctx())).text)
    expect(out.url).toBe('https://a.example.test/final')
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain('https://a.example.test/final')
  })

  it('rejects a non-2xx response', async () => {
    stubPage(() => new Response('nope', { status: 404, statusText: 'Not Found' }))
    await expect(
      webFetch().run({ url: 'https://docs.example.test/missing', prompt: 'q' }, ctx()),
    ).rejects.toThrow(/HTTP 404/)
  })

  it('rejects a response larger than 5 MiB', async () => {
    stubPage(
      () =>
        new Response('tiny', {
          headers: { 'content-type': 'text/html', 'content-length': String(6 * 1024 * 1024) },
        }),
    )
    await expect(
      webFetch().run({ url: 'https://docs.example.test/huge', prompt: 'q' }, ctx()),
    ).rejects.toThrow(/exceeds .* bytes/)
  })

  it('honors the interrupt signal', async () => {
    stubPage(() => htmlResponse(PAGE_HTML))
    const controller = new AbortController()
    controller.abort()
    await expect(
      webFetch().run({ url: 'https://docs.example.test/page', prompt: 'q' }, ctx(controller.signal)),
    ).rejects.toThrow()
  })

  it('rejects an invalid offset', async () => {
    stubPage(() => htmlResponse(PAGE_HTML))
    await expect(
      webFetch().run({ url: 'https://docs.example.test/page', prompt: 'q', offset: -1 }, ctx()),
    ).rejects.toBeInstanceOf(ToolInputError)
  })

  it('registers the WebFetch prompt section order and guidance', () => {
    const tool = webFetch()
    expect(tool.name).toBe('WebFetch')
    expect(tool.promptOrder).toBe(160)
    expect(tool.guidance).toBe(WEB_FETCH_GUIDANCE)
  })
})

// ── WebSearch ───────────────────────────────────────────────────────

interface FixtureRow {
  title: string
  url: string
  snippet: string
}

function ddgHtml(rows: FixtureRow[]): string {
  return `<html><body>${rows
    .map(
      (row) => `
    <div class="result results_links results_links_deep web-result">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(row.url)}&amp;rut=abc">${row.title}</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(row.url)}">${row.snippet}</a>
      </div>
    </div>`,
    )
    .join('')}</body></html>`
}

function searchResponse(html: string): FetchMock {
  return stubFetch(() => htmlResponse(html))
}

describe('parseDuckDuckGoResults', () => {
  it('parses titles, unwraps result URLs and reads snippets in document order', () => {
    const html = ddgHtml([
      { title: 'First &amp; Best', url: 'https://example.com/a', snippet: 'Alpha <b>snippet</b>' },
      { title: 'Second', url: 'https://other.test/b', snippet: 'Beta snippet' },
    ])
    expect(parseDuckDuckGoResults(html)).toEqual([
      { title: 'First & Best', url: 'https://example.com/a', snippet: 'Alpha snippet' },
      { title: 'Second', url: 'https://other.test/b', snippet: 'Beta snippet' },
    ])
  })

  it('reads a div-based snippet container', () => {
    const html = `
      <a class="result__a" href="https://example.com/a">Title</a>
      <div class="result__snippet js-result-snippet">Snippet text</div>`
    expect(parseDuckDuckGoResults(html)).toEqual([
      { title: 'Title', url: 'https://example.com/a', snippet: 'Snippet text' },
    ])
  })
})

describe('webSearchTool', () => {
  const rows: FixtureRow[] = [
    { title: 'Example result', url: 'https://example.com/page', snippet: 'Example snippet' },
    { title: 'Docs result', url: 'https://docs.example.com/guide', snippet: 'Docs snippet' },
    { title: 'Other result', url: 'https://other.test/x', snippet: 'Other snippet' },
  ]

  it('queries DuckDuckGo, parses results and sets searchCount', async () => {
    const mock = searchResponse(ddgHtml(rows))
    const out = parse<{
      query: string
      results: FixtureRow[]
      durationSeconds: number
      searchCount: number
    }>((await webSearchTool.run({ query: 'example query' }, ctx())).text)

    expect(out.query).toBe('example query')
    expect(out.results).toEqual(rows)
    expect(typeof out.durationSeconds).toBe('number')
    expect(typeof out.searchCount).toBe('number')
    expect(out.searchCount).toBeGreaterThan(0)

    const [url, init] = mock.mock.calls[0]
    expect(String(url)).toBe('https://html.duckduckgo.com/html/?q=example%20query')
    expect((init as RequestInit).redirect).toBe('manual')
    expect((init as RequestInit).headers as Record<string, string>).toMatchObject({
      'user-agent': expect.stringContaining('Mozilla'),
    })
  })

  it('increments searchCount per invocation', async () => {
    searchResponse(ddgHtml(rows))
    const first = parse<{ searchCount: number }>((await webSearchTool.run({ query: 'one' }, ctx())).text)
    const second = parse<{ searchCount: number }>((await webSearchTool.run({ query: 'two' }, ctx())).text)
    expect(second.searchCount).toBe(first.searchCount + 1)
  })

  it('applies the allowed_domains allowlist, including subdomains', async () => {
    searchResponse(ddgHtml(rows))
    const out = parse<{ results: FixtureRow[] }>(
      (await webSearchTool.run({ query: 'q', allowed_domains: ['example.com'] }, ctx())).text,
    )
    expect(out.results.map((result) => result.url)).toEqual([
      'https://example.com/page',
      'https://docs.example.com/guide',
    ])
  })

  it('applies the blocked_domains blocklist and lets it win over the allowlist', async () => {
    searchResponse(ddgHtml(rows))
    const blocked = parse<{ results: FixtureRow[] }>(
      (await webSearchTool.run({ query: 'q', blocked_domains: ['other.test'] }, ctx())).text,
    )
    expect(blocked.results.map((result) => result.url)).toEqual([
      'https://example.com/page',
      'https://docs.example.com/guide',
    ])

    const both = parse<{ results: FixtureRow[] }>(
      (
        await webSearchTool.run(
          { query: 'q', allowed_domains: ['example.com'], blocked_domains: ['docs.example.com'] },
          ctx(),
        )
      ).text,
    )
    expect(both.results.map((result) => result.url)).toEqual(['https://example.com/page'])
  })

  it('caps results at ten', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      title: `Result ${index}`,
      url: `https://site${index}.test/page`,
      snippet: `Snippet ${index}`,
    }))
    searchResponse(ddgHtml(many))
    const out = parse<{ results: FixtureRow[] }>(
      (await webSearchTool.run({ query: 'q' }, ctx())).text,
    )
    expect(out.results).toHaveLength(10)
    expect(out.results[0].title).toBe('Result 0')
  })

  it('returns an empty result list when the page has no rows', async () => {
    searchResponse('<html><body><div class="no-results">No results.</div></body></html>')
    const out = parse<{ results: FixtureRow[] }>(
      (await webSearchTool.run({ query: 'nothing' }, ctx())).text,
    )
    expect(out.results).toEqual([])
  })

  it('rejects a non-2xx response instead of returning an empty list', async () => {
    stubFetch(() => new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }))
    await expect(webSearchTool.run({ query: 'q' }, ctx())).rejects.toThrow(/HTTP 429/)
  })

  it('rejects an empty query without touching the network', async () => {
    stubFetch(() => {
      throw new Error('fetch must not run')
    })
    await expect(webSearchTool.run({ query: '   ' }, ctx())).rejects.toThrow(/non-empty/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('registers the WebSearch prompt section order', () => {
    expect(webSearchTool.name).toBe('WebSearch')
    expect(webSearchTool.promptOrder).toBe(170)
  })
})