// `prompts/get` result → prompt text for the native command path.
//
// Neutral module: no Node I/O. The CLI converts each returned message content
// block into prompt blocks (text / image / audio / resource / resource_link),
// saving binary payloads as attachments. Native deliberately renders text-only:
// binary payloads become a bracketed note rather than an attachment, so a
// prompt command never silently grows the CAS (documented deviation in the
// agent note).

import { createLogger } from '../../../log.js'

const log = createLogger('native-mcp-prompts')

interface PromptContentBlock {
  type?: string
  text?: unknown
  mimeType?: unknown
  data?: unknown
  blob?: unknown
  name?: unknown
  uri?: unknown
  description?: unknown
  resource?: { uri?: unknown; text?: unknown; blob?: unknown; mimeType?: unknown }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Render one content block, or undefined when it carries nothing textual. */
function renderBlock(server: string, block: PromptContentBlock): string | undefined {
  switch (block.type) {
    case 'text': {
      const text = str(block.text)
      return text === undefined ? undefined : text
    }
    case 'resource': {
      const resource = block.resource ?? {}
      const uri = str(resource.uri) ?? 'unknown'
      const text = str(resource.text)
      if (text !== undefined) return `[Resource from ${server} at ${uri}] ${text}`
      const mimeType = str(resource.mimeType) ?? 'unknown type'
      const size = typeof resource.blob === 'string' ? resource.blob.length : 0
      return `[Resource from ${server} at ${uri}] Binary content (${mimeType}, ${size} bytes) is not inlined.`
    }
    case 'resource_link': {
      const name = str(block.name) ?? 'unknown'
      const uri = str(block.uri) ?? 'unknown'
      let text = `[Resource link: ${name}] ${uri}`
      const description = str(block.description)
      if (description !== undefined) text += ` (${description})`
      return text
    }
    case 'image':
    case 'audio': {
      const mimeType = str(block.mimeType) ?? 'unknown type'
      const payload = typeof block.data === 'string' ? block.data : typeof block.blob === 'string' ? block.blob : ''
      const size = payload.length
      return `[${block.type === 'image' ? 'Image' : 'Audio'} from ${server}] Binary content (${mimeType}, ${size} bytes) is not inlined.`
    }
    default:
      return undefined
  }
}

/** Convert a `prompts/get` result into the prompt body injected for the turn.
 *  Throws on a malformed result: a prompt command that produced nothing would
 *  otherwise run the model on the bare `/mcp__…` literal. */
export function renderMcpPromptMessages(server: string, result: unknown): string {
  const messages = (result as { messages?: unknown } | undefined)?.messages
  if (!Array.isArray(messages)) throw new Error(`MCP prompt from "${server}" returned no messages`)
  const parts: string[] = []
  for (const message of messages) {
    const content = (message as { content?: unknown } | undefined)?.content
    const blocks = Array.isArray(content) ? content : content === undefined ? [] : [content]
    for (const block of blocks) {
      const text = renderBlock(server, block as PromptContentBlock)
      if (text !== undefined && text.length > 0) parts.push(text)
    }
  }
  if (parts.length === 0) throw new Error(`MCP prompt from "${server}" returned no renderable content`)
  log.debug(`rendered prompt from ${server}: ${parts.length} block(s)`)
  return parts.join('\n\n')
}
