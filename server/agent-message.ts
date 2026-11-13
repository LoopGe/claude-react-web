import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { fileHandleText } from '../shared/upload-handle.js'
import type { FileBlock } from '../shared/attachments.js'

export type AgentMessage = SDKMessage

/** Server/provider-only attachment metadata. The browser-facing FileBlock
 *  deliberately never gains the registry path or observed media type. */
export interface ResolvedFileAttachment {
  id: string
  name: string
  size: number
  digest: string
  /** Registry-owned, read-only alias path; never a caller-supplied path. */
  path: string
  /** Server-observed type. PDF eligibility additionally requires a magic check. */
  mediaType?: string
}

export interface ResolvedFileBlock {
  type: 'file'
  attachment: ResolvedFileAttachment
}

type SdkContentBlock = Exclude<SDKUserMessage['message']['content'], string>[number]
export type ProviderContentBlock = SdkContentBlock | ResolvedFileBlock | {
  type: 'image'
  source: { type: 'base64'; data: string; media_type: string }
}
/** HTTP validation checks the broad string media_type before the SDK boundary. */
export type ProviderInputContentBlock = ProviderContentBlock | FileBlock

/** Provider-neutral user input. SDK-specific content remains accepted, while
 *  resolved file blocks travel without pretending to be SDK MessageParams. */
export type AgentUserMessage = Omit<SDKUserMessage, 'message'> & {
  message: Omit<SDKUserMessage['message'], 'content'> & {
    content: string | ProviderContentBlock[]
  }
}

/** Public input/history form: a FileBlock has no registry path until the
 *  manager resolves it into the provider form above. */
export type PublicAgentUserMessage = Omit<AgentUserMessage, 'message'> & {
  message: Omit<AgentUserMessage['message'], 'content'> & {
    content: string | ProviderInputContentBlock[]
  }
}

export type AnyAgentUserMessage = AgentUserMessage | PublicAgentUserMessage

/** Preserve the host's direct-hand-off consumption stamp across a provider's
 *  content-projection clone. Later asynchronous consumption needs no copy:
 *  the manager's ring scan handles it by uuid. */
export function copyConsumedAt(source: AgentUserMessage, target: AgentUserMessage): void {
  const consumedAt = (source as { consumedAt?: unknown }).consumedAt
  if (typeof consumedAt === 'number') {
    ;(target as { consumedAt?: number }).consumedAt = consumedAt
  }
}

/** Project provider-neutral files for a legacy text-only provider boundary.
 *  Clones only when a file needs projection; the public copy is never mutated. */
export function projectFileBlocksForProvider(message: AgentUserMessage): AgentUserMessage {
  const content = message.message.content
  if (!Array.isArray(content) || !content.some((block) => block.type === 'file')) return message
  return {
    ...message,
    message: {
      ...message.message,
      content: content.map((block) => block.type === 'file'
        ? {
            type: 'text' as const,
            text: fileHandleText(block.attachment, block.attachment.path),
          }
        : block),
    },
  }
}
