// server/providers/native/tools/web-search.ts
//
// WebSearch over DuckDuckGo's HTML endpoint (no API key). The endpoint returns
// ordinary markup, so the parser walks result anchors in document order:
// `result__a` carries the title and wrapped `uddg` URL, the following
// `result__snippet` (anchor or div) carries the snippet. Domain filters are
// applied locally and the list is capped at ten results.
import { capToolText } from './bash.js'
import { fetchWeb, htmlToText } from './web.js'
import { ToolInputError, type ToolDef } from './types.js'

const SEARCH_URL = 'https://html.duckduckgo.com/html/'
const MAX_RESULTS = 10

export const WEB_SEARCH_GUIDANCE =
  'WebSearch queries DuckDuckGo and returns up to 10 result titles, URLs and snippets; allowed_domains/blocked_domains filter by host.'

export type WebSearchInput = {
  query: string
  allowed_domains?: string[]
  blocked_domains?: string[]
}

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchOutput {
  query: string
  results: WebSearchResult[]
  durationSeconds: number
  searchCount: number
}

/** DuckDuckGo serves results wrapped in `/l/?uddg=<encoded target>` links, so
 *  a result's href is not the destination. Unwrap it (the query string is
 *  already entity-decoded by `htmlToText`? No — the href is read raw, so
 *  `&amp;` is decoded here first). */
function unwrapResultUrl(href: string): string | null {
  const decoded = href.replace(/&amp;/gi, '&')
  let parsed: URL
  try {
    parsed = new URL(decoded, SEARCH_URL)
  } catch {
    return null
  }
  let target = parsed.href
  if (parsed.pathname === '/l/' || parsed.pathname === '/l') {
    target = parsed.searchParams.get('uddg') ?? target
  }
  try {
    const final = new URL(target)
    return final.protocol === 'http:' || final.protocol === 'https:' ? final.href : null
  } catch {
    return null
  }
}

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined
}

function hasClass(attrs: string, name: string): boolean {
  const value = attribute(attrs, 'class')
  return value !== undefined && value.split(/\s+/).includes(name)
}

// One ordered scan over the two elements that carry a result: an anchor
// (title or snippet) or a snippet `<div>`. Anchors cannot nest, so the
// non-greedy inner group is safe; the div alternative only matches the
// snippet container, which never contains a nested div on this endpoint.
const RESULT_TOKEN_RE =
  /<a\b([^>]*)>([\s\S]*?)<\/a\s*>|<div\b([^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*)>([\s\S]*?)<\/div\s*>/gi

/** Parse result rows out of DuckDuckGo's HTML. Pure and exported so the test
 *  suite can feed fixtures without a network stub. */
export function parseDuckDuckGoResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = []
  let current: WebSearchResult | null = null
  for (const match of html.matchAll(RESULT_TOKEN_RE)) {
    if (match[1] !== undefined) {
      const attrs = match[1]
      if (hasClass(attrs, 'result__a')) {
        const href = attribute(attrs, 'href')
        const url = href ? unwrapResultUrl(href) : null
        if (!url) continue
        current = { title: htmlToText(match[2] ?? ''), url, snippet: '' }
        results.push(current)
      } else if (hasClass(attrs, 'result__snippet') && current && !current.snippet) {
        current.snippet = htmlToText(match[2] ?? '')
      }
    } else if (current && !current.snippet) {
      current.snippet = htmlToText(match[4] ?? '')
    }
  }
  return results
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.$/, '')
}

function hostMatches(host: string, domain: string): boolean {
  const normalized = normalizeDomain(domain)
  if (!normalized) return false
  return host === normalized || host.endsWith(`.${normalized}`)
}

function hostOf(url: string): string {
  // Same normalization as the filter domains: a result URL's hostname keeps a
  // trailing dot (`https://evil.com./`), which would otherwise dodge a
  // `blocked_domains: ['evil.com']` entry.
  return normalizeDomain(new URL(url).hostname)
}

/** `searchCount` lives in the factory closure, so it is scoped to one
 *  session's tool instance: two sessions running searches never see each
 *  other's counts. */
export function createWebSearchTool(): ToolDef<WebSearchInput> {
  let searchCount = 0
  return {
    name: 'WebSearch',
    description: 'Search the web with DuckDuckGo and return result titles, URLs and snippets.',
    guidance: WEB_SEARCH_GUIDANCE,
    promptOrder: 170,
    readOnlyHint: true,
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        allowed_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only return results from these hosts (subdomains included).',
        },
        blocked_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Drop results from these hosts (subdomains included).',
        },
      },
      required: ['query'],
    },
    async run(input, ctx) {
      const query = typeof input.query === 'string' ? input.query.trim() : ''
      if (query === '') throw new ToolInputError('query must be a non-empty string')
      const started = Date.now()
      searchCount++
      const response = await fetchWeb(`${SEARCH_URL}?q=${encodeURIComponent(query)}`, {
        signal: ctx.signal,
        format: 'html',
      })
      const allowed = (input.allowed_domains ?? []).filter((domain) => normalizeDomain(domain) !== '')
      const blocked = (input.blocked_domains ?? []).filter((domain) => normalizeDomain(domain) !== '')
      const results = parseDuckDuckGoResults(response.text)
        .filter((result) => {
          const host = hostOf(result.url)
          if (allowed.length > 0 && !allowed.some((domain) => hostMatches(host, domain))) return false
          if (blocked.some((domain) => hostMatches(host, domain))) return false
          return true
        })
        .slice(0, MAX_RESULTS)
      const output: WebSearchOutput = {
        query,
        results,
        durationSeconds: (Date.now() - started) / 1000,
        searchCount,
      }
      return { text: capToolText(JSON.stringify(output)) }
    },
  }
}