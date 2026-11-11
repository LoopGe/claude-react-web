// server/providers/native/tools/web-fetch.ts
//
// WebFetch: fetch one public page, reduce it to text, and answer the model's
// prompt over that text with a second (auxiliary) Anthropic call. It is a
// per-session factory rather than a static ToolDef because the aux call needs
// the session's model and profile credentials.
import { callAnthropicMessages } from '../../../anthropic-api.js'
import type { ProviderProfile } from '../../../config.js'
import { capToolText } from './bash.js'
import { ToolInputError, type ToolDef } from './types.js'
import { fetchWeb } from './web.js'

export const WEB_FETCH_GUIDANCE =
  'WebFetch fetches a public HTTP(S) page, reduces it to text, and answers the prompt from that text; private addresses, credentials in the URL and cross-origin redirects are refused.'

export interface WebFetchDeps {
  /** The session's current model — used when the profile has no recap model. */
  model: () => string
  profile?: ProviderProfile
  credentials: () => { baseUrl: string; authToken: string }
}

export type WebFetchInput = {
  url: string
  prompt: string
  /** Character offset into the decoded page text; lets the model read past
   *  the first window of a long page. */
  offset?: number
}

export interface WebFetchOutput {
  bytes: number
  code: number
  codeText: string
  result: string
  durationMs: number
  url: string
}

export function createWebFetchTool(deps: WebFetchDeps): ToolDef<WebFetchInput> {
  return {
    name: 'WebFetch',
    description: 'Fetch a URL and answer a prompt about its text content.',
    guidance: WEB_FETCH_GUIDANCE,
    promptOrder: 160,
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute HTTP(S) URL to fetch.' },
        prompt: { type: 'string', description: 'What to extract or answer from the page.' },
        offset: {
          type: 'number',
          description: 'Character offset into the page text to start from (for long pages).',
        },
      },
      required: ['url', 'prompt'],
    },
    async run(input, ctx) {
      if (typeof input.url !== 'string' || input.url.trim() === '') {
        throw new ToolInputError('url must be a non-empty string')
      }
      if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
        throw new ToolInputError('prompt must be a non-empty string')
      }
      const offset = input.offset ?? 0
      if (!Number.isInteger(offset) || offset < 0) {
        throw new ToolInputError('offset must be a non-negative integer')
      }
      const started = Date.now()
      const page = await fetchWeb(input.url, { signal: ctx.signal })
      const body = offset > 0 ? page.text.slice(offset) : page.text
      if (body.trim() === '') {
        throw new ToolInputError(`no text content at ${page.url}`)
      }
      const result = await callAnthropicMessages({
        model: deps.profile?.recapModel || deps.model(),
        system: body,
        userContent: input.prompt,
        maxTokens: 1024,
        temperature: 0.2,
        caller: 'web-fetch',
        target: deps.credentials(),
        signal: ctx.signal,
      })
      const output: WebFetchOutput = {
        bytes: page.bytes,
        code: page.status,
        codeText: page.statusText,
        result,
        durationMs: Date.now() - started,
        url: page.url,
      }
      return { text: capToolText(JSON.stringify(output)) }
    },
  }
}