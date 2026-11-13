// Read a registry-backed attachment occurrence without widening Read's cwd
// boundary. One verified stream hashes every byte, fatally decodes UTF-8, and
// retains only the requested line window; no text escapes before EOF validation.

import { TextDecoder } from 'node:util'
import { AttachmentObjectStore, AttachmentStoreError } from '../../../attachment-object-store.js'
import { resolveAuthorizedAttachment } from '../../../attachment-access.js'
import { HttpError } from '../../../errors.js'
import { createLogger } from '../../../log.js'
import type { NativeAttachmentReferenceIndex } from '../../../attachment-reference-index.js'
import type { UploadStore } from '../../../upload-store.js'
import type { ToolDef, ToolOutcome } from './types.js'

const MAX_LINES = 2000
const MAX_OUTPUT_BYTES = 64 * 1024
const OUTPUT_TRUNCATION_MARKER = '\n[Output truncated at 64 KiB]'

const log = createLogger('attachment-read')

export const ATTACHMENT_READ_GUIDANCE =
  'Use AttachmentRead with an upload id from an attachment handle to read its text; never substitute a registry path or a digest reference.'

export interface AttachmentReadDeps {
  uploadStore: UploadStore
  stateDir: string
  referenceIndex: NativeAttachmentReferenceIndex
  sessionId: string
}

interface ReadTextInput extends Record<string, unknown> {
  id: string
  offset?: number
  limit?: number
}

class InvalidUtf8Error extends Error {}

function utf8Prefix(value: string, maxBytes: number): { text: string; complete: boolean } {
  let bytes = 0
  let text = ''
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) return { text, complete: false }
    text += char
    bytes += size
  }
  return { text, complete: true }
}

function errorOutcome(id: string, name: string | undefined, reason: string): ToolOutcome {
  return {
    text: `AttachmentRead failed for upload ${id} (${name ?? 'unknown attachment'}): ${reason}`,
    isError: true,
  }
}

function safeReason(err: unknown): string {
  if (err instanceof InvalidUtf8Error) return 'attachment is not valid UTF-8 text'
  if (err instanceof AttachmentStoreError) {
    if (err.code === 'corrupt') return 'attachment failed integrity verification'
    if (err.code === 'missing') return 'uploaded file is missing'
  }
  if (err instanceof HttpError) return err.message
  return 'the uploaded file could not be read'
}

/** Bounded line collector. Skipped lines and the unreturned tail of a long
 * line are discarded as their chunks arrive, so memory does not scale with
 * upload size. */
class LineWindow {
  private lineNumber = 1
  private currentLine = ''
  private currentLineBytes = 0
  private body = ''
  private bodyBytes = 0
  private firstReturned: number | undefined
  private lastReturned: number | undefined
  private totalLines = 0
  private lineLimitTruncated = false
  private contentTruncated = false
  private outputTruncated = false

  constructor(private readonly offset: number, private readonly limit: number) {}

  feed(text: string): void {
    let rest = text
    while (rest.length > 0) {
      const newline = rest.indexOf('\n')
      const segment = newline === -1 ? rest : rest.slice(0, newline)
      this.captureSegment(segment)
      if (newline === -1) return
      this.finishLine()
      rest = rest.slice(newline + 1)
    }
  }

  finish(): void {
    // Like Read's split('\n'), an empty file and a trailing newline both have a
    // final empty line.
    this.finishLine()
  }

  private capturing(): boolean {
    return this.lineNumber >= this.offset && this.lineNumber < this.offset + this.limit
  }

  private captureSegment(segment: string): void {
    if (!this.capturing() || segment.length === 0) return
    const remaining = MAX_OUTPUT_BYTES - this.currentLineBytes
    if (remaining === 0) {
      this.contentTruncated = true
      return
    }
    const prefix = utf8Prefix(segment, remaining)
    this.currentLine += prefix.text
    this.currentLineBytes += Buffer.byteLength(prefix.text, 'utf8')
    if (!prefix.complete) this.contentTruncated = true
  }

  private appendBody(value: string): void {
    if (this.bodyBytes >= MAX_OUTPUT_BYTES) {
      this.outputTruncated = true
      return
    }
    const prefix = utf8Prefix(value, MAX_OUTPUT_BYTES - this.bodyBytes)
    this.body += prefix.text
    this.bodyBytes += Buffer.byteLength(prefix.text, 'utf8')
    if (!prefix.complete) this.outputTruncated = true
  }

  private finishLine(): void {
    if (this.capturing()) {
      this.firstReturned ??= this.lineNumber
      this.lastReturned = this.lineNumber
      if (this.firstReturned !== this.lastReturned || this.bodyBytes > 0) this.appendBody('\n')
      this.appendBody(`${String(this.lineNumber).padStart(6)}\t${this.currentLine}`)
    } else if (this.lineNumber >= this.offset + this.limit) {
      this.lineLimitTruncated = true
    }
    this.totalLines++
    this.lineNumber++
    this.currentLine = ''
    this.currentLineBytes = 0
  }

  render(name: string): string {
    const range = this.firstReturned === undefined
      ? `Lines: none (file has ${this.totalLines} lines)`
      : `Lines: ${this.firstReturned}-${this.lastReturned}`
    const truncated = this.lineLimitTruncated || this.contentTruncated || this.outputTruncated
    const header = `Attachment: ${name}\n${range}\nTruncated: ${truncated ? 'yes' : 'no'}\n`
    const text = header + this.body
    if (Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES) return text
    const markedHeader = `Attachment: ${name}\n${range}\nTruncated: yes\n`
    const marked = markedHeader + this.body
    const prefix = utf8Prefix(marked, MAX_OUTPUT_BYTES - Buffer.byteLength(OUTPUT_TRUNCATION_MARKER, 'utf8'))
    return prefix.text + OUTPUT_TRUNCATION_MARKER
  }
}

async function readText(
  deps: AttachmentReadDeps,
  occurrence: Parameters<typeof resolveAuthorizedAttachment>[0],
  offset: number,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  const resolved = await resolveAuthorizedAttachment(occurrence, {
    uploadStore: deps.uploadStore,
    stateDir: deps.stateDir,
  })
  const objects = new AttachmentObjectStore(deps.stateDir)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const window = new LineWindow(offset, limit)
  try {
    for await (const chunk of objects.readVerified({
      path: resolved.path,
      digest: resolved.digest,
      size: resolved.size,
      signal,
    })) {
      window.feed(decoder.decode(chunk, { stream: true }))
    }
    window.feed(decoder.decode())
  } catch (err) {
    if (err instanceof TypeError) {
      throw new InvalidUtf8Error(err instanceof Error ? err.message : String(err))
    }
    throw err
  }
  window.finish()
  return window.render(resolved.name)
}

export function createAttachmentReadTool(deps: AttachmentReadDeps): ToolDef<ReadTextInput> {
  return {
    name: 'AttachmentRead',
    description: 'Read the text content of an uploaded attachment referenced by this session.',
    guidance: ATTACHMENT_READ_GUIDANCE,
    promptOrder: 105,
    readOnlyHint: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Registry upload id from the attachment handle; not a path or digest reference.' },
        offset: { type: 'number', description: '1-based first text line to return. Defaults to 1. Not valid for PDF.' },
        limit: { type: 'number', description: `Maximum text lines to return, up to ${MAX_LINES}. Defaults to ${MAX_LINES}. Not valid for PDF.` },
      },
      required: ['id'],
    },
    async run(input, ctx) {
      const occurrence = deps.referenceIndex.occurrencesForSession(deps.sessionId)
        .find((candidate) => candidate.id === input.id)
      try {
        if (typeof input.id !== 'string' || input.id.length === 0) {
          return errorOutcome(String(input.id), undefined, 'a non-empty upload id is required')
        }
        if (!occurrence) {
          return errorOutcome(input.id, undefined, 'upload is not referenced by this session\'s native log')
        }
        if (occurrence.mediaType === 'application/pdf') {
          if (input.offset !== undefined || input.limit !== undefined) {
            return errorOutcome(input.id, occurrence.name, 'PDF attachments do not accept offset or limit pagination')
          }
          return errorOutcome(input.id, occurrence.name, 'PDF document reading is not available for this attachment')
        }
        const offset = Math.max(1, Math.floor(input.offset ?? 1))
        const limit = Math.min(MAX_LINES, Math.max(1, Math.floor(input.limit ?? MAX_LINES)))
        const text = await readText(deps, occurrence, offset, limit, ctx.signal)
        return { text }
      } catch (err) {
        if (ctx.signal.aborted) {
          return errorOutcome(input.id, occurrence?.name, 'attachment read was interrupted')
        }
        log.warn(`AttachmentRead failed for upload ${input.id}: ${err instanceof Error ? err.message : String(err)}`)
        return errorOutcome(input.id, occurrence?.name, safeReason(err))
      }
    },
  }
}
