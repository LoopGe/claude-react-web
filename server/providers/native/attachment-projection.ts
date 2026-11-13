import type { RawLine } from '../../history-reader.js'
import type { UploadStore } from '../../upload-store.js'
import { createLogger } from '../../log.js'
import type { NativeFileAttachment } from './session-log/format.js'
import {
  loadPdfDocument,
  safePdfReadReason,
  type PreparedPdfStore,
} from './pdf-documents.js'

const log = createLogger('attachment-projection')

export interface NativeProjectionOptions {
  /** Required only by byte-bearing projections. Plain handles never read the
   * registry or attachment bytes. */
  uploadStore?: UploadStore
  stateDir: string
  /** One verified AttachmentRead result may be consumed by the immediately
   * following projection. Later rounds always re-read and re-verify. */
  preparedPdfs?: PreparedPdfStore
}

/** The native handle is deliberately fixed text: changing the active tool
 * profile must not rewrite an earlier history prefix on a later API round. */
export function nativeFileHandleText(attachment: NativeFileAttachment): string {
  return [
    `Name: ${attachment.name}`,
    `Upload id: ${attachment.id}`,
    `Size: ${attachment.size} bytes`,
    `Digest: ${attachment.digest.slice(0, 8)}`,
    `Read-only path: ${attachment.path}`,
    `If AttachmentRead is available in the current turn, call it with ${JSON.stringify({ id: attachment.id })} to read text content. Otherwise, the current tool configuration cannot read the attachment content; enable AttachmentRead instead of guessing at the bytes.`,
    'Do not pass this path to Read or use it to bypass the working-directory boundary. The path is only for host tools that explicitly support it.',
    'When delegating attachment reading, include the upload id so the subagent can call AttachmentRead; do not delegate only this path outside the working directory.',
    'Copy the attachment to a writable location before modifying it.',
  ].join('\n')
}

interface ContentBlockLike {
  type?: unknown
  attachment?: NativeFileAttachment
  content?: unknown
  [key: string]: unknown
}

function isNativeFileBlock(block: unknown): block is ContentBlockLike & { type: 'file'; attachment: NativeFileAttachment } {
  return typeof block === 'object' && block !== null
    && (block as ContentBlockLike).type === 'file'
    && typeof (block as ContentBlockLike).attachment === 'object'
    && (block as ContentBlockLike).attachment !== null
}

async function modelBlock(
  block: unknown,
  opts: NativeProjectionOptions,
  signal: AbortSignal,
  toolUseId?: string,
): Promise<unknown> {
  if (!isNativeFileBlock(block)) return block
  const attachment = block.attachment
  if (attachment.modelForm === 'handle') {
    return { type: 'text', text: nativeFileHandleText(attachment) }
  }
  if (attachment.modelForm === 'pdf-document') {
    if (signal.aborted) throw signal.reason
    if (toolUseId && opts.preparedPdfs) {
      const prepared = opts.preparedPdfs.consume(toolUseId, attachment)
      if (prepared) return prepared
    }
    if (!opts.uploadStore) {
      throw new Error(`upload registry is unavailable for attachment: ${attachment.id}`)
    }
    try {
      return await loadPdfDocument(attachment, {
        uploadStore: opts.uploadStore,
        stateDir: opts.stateDir,
      }, signal)
    } catch (err) {
      if (signal.aborted) throw signal.reason
      log.warn(`PDF projection failed for upload ${attachment.id}: ${err instanceof Error ? err.message : String(err)}`)
      throw new Error(
        `PDF document projection failed for upload ${attachment.id} (${attachment.name}): ${safePdfReadReason(err)}`,
      )
    }
  }
  throw new Error(`unsupported native attachment model form: ${String(attachment.modelForm)}`)
}

/** Build an independent request copy on EVERY API round. Canonical history,
 * the native log and the public UI transcript are never mutated. */
export async function projectNativeMessages(
  history: readonly unknown[],
  opts: NativeProjectionOptions,
  signal: AbortSignal,
): Promise<unknown[]> {
  const projected = structuredClone(history) as Array<{ role?: unknown; content?: unknown }>
  for (const message of projected) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    const content = message.content as unknown[]
    for (let index = 0; index < content.length; index++) {
      const block = content[index] as ContentBlockLike
      content[index] = await modelBlock(block, opts, signal)
      if (block?.type !== 'tool_result' || !Array.isArray(block.content)) continue
      const inner = block.content as unknown[]
      for (let innerIndex = 0; innerIndex < inner.length; innerIndex++) {
        inner[innerIndex] = await modelBlock(
          inner[innerIndex],
          opts,
          signal,
          typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
        )
      }
    }
  }
  return projected
}

function publicContent(content: unknown[]): unknown[] {
  return content.flatMap((value) => {
    if (isNativeFileBlock(value)) {
      const attachment = value.attachment
      return [{
        type: 'file',
        attachment: {
          id: attachment.id,
          name: attachment.name,
          size: attachment.size,
          digest: attachment.digest,
        },
      }]
    }
    const block = value as ContentBlockLike
    if (block?.type === 'tool_result' && Array.isArray(block.content)) {
      return [{
        ...block,
        content: (block.content as unknown[]).filter((inner) => !isNativeFileBlock(inner)),
      }]
    }
    return [value]
  })
}

/** Public disk/live-subagent projection. Only direct user file occurrences
 * become public FileBlocks; structured tool-result files stay internal. */
export function publicNativeHistoryLine<T extends RawLine>(line: T): T {
  if (line.type !== 'user' || !Array.isArray(line.message?.content)) return line
  return {
    ...line,
    message: {
      ...line.message,
      content: publicContent(line.message.content),
    },
  } as T
}
