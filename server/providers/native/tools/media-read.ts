// server/providers/native/tools/media-read.ts
// Model-facing results for binary media the two read entry points can return:
// Read (a file inside the session working directory) and AttachmentRead (an
// uploaded registry occurrence). Validation, publication, budget and the
// prepared handoff live here once, so both entry points share one contract:
// the tool result carries a store-backed REF block; attachment-projection
// turns it into the verified base64/document block for the request that
// follows.

import { basename } from 'node:path'
import { AttachmentStoreError } from '../../../../shared/attachment-store-error.js'
import type { NativeFileAttachment } from '../../../../shared/attachment-types.js'
import {
  IMAGE_MAX_BYTES,
  ImageReadError,
  imageModelBlockOf,
  imageRefBlockOf,
  validateImageForModel,
  type PreparedImageStore,
} from '../image-documents.js'
import {
  PDF_MAX_BYTES,
  PDF_MAX_BASE64_CHARS,
  PdfReadError,
  pdfDocumentBlockOf,
  safePdfReadReason,
  type PdfBudgetLedger,
  type PreparedPdfStore,
} from '../pdf-documents.js'
import type { NativeAttachmentPort, NativeImagePort } from '../ports.js'
import { ToolInputError, type ToolContext, type ToolOutcome } from './types.js'

export interface NativeMediaReadDeps {
  imagePort?: NativeImagePort
  attachmentPort?: NativeAttachmentPort
  pdfBudgets?: PdfBudgetLedger
  preparedPdfs?: PreparedPdfStore
  preparedImages?: PreparedImageStore
  pdfDocumentsEnabled?: () => boolean
}

function historyKeyOf(ctx: ToolContext): string {
  return ctx.historyKey ?? 'main'
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(2)} MB`
}

/** Model-safe failure for any media read: caps already phrase themselves, and
 *  store/registry errors collapse to one neutral sentence. */
export function safeMediaReadReason(err: unknown): string | undefined {
  if (err instanceof ImageReadError) return err.message
  if (err instanceof PdfReadError || err instanceof AttachmentStoreError) return safePdfReadReason(err)
  return undefined
}

/** A new occurrence of image bytes: validate against the API caps, publish it
 *  to the content-addressed store, claim request-media room, and hand back the
 *  neutral ref block that the next projection consumes. */
export async function imageOutcomeFromBytes(
  deps: NativeMediaReadDeps,
  ctx: ToolContext,
  input: { bytes: Buffer; name: string },
): Promise<ToolOutcome> {
  const imagePort = deps.imagePort
  const ledger = deps.pdfBudgets
  if (!imagePort || !ledger) {
    throw new ToolInputError('image reading is unavailable in this host: no image store is wired')
  }
  if (input.bytes.length > IMAGE_MAX_BYTES) {
    throw new ToolInputError(`image exceeds the ${formatBytes(IMAGE_MAX_BYTES)} per-image limit; resize or re-encode it before reading`)
  }
  const meta = validateImageForModel(input.bytes)
  const published = await imagePort.publishImage(input.bytes, meta, ctx.signal)
  const attachment = imageRefBlockOf(published.digest, { ...meta, bytes: published.bytes }).attachment
  const attempt = ledger.reserveImageBudget(historyKeyOf(ctx), published.bytes, published.digest)
  if (!attempt.ok) {
    if (attempt.reason === 'duplicate') {
      return {
        text: `Image ${input.name} is already included in the conversation above (${meta.width}x${meta.height} ${meta.mediaType}); refer to it there instead of re-reading it.`,
      }
    }
    throw new ToolInputError(
      `the request media budget of ${PDF_MAX_BASE64_CHARS.toLocaleString('en-US')} base64 characters is exhausted; images and PDF documents share it, so start a new session or remove earlier media`,
    )
  }
  const text = [
    `Image: ${input.name}`,
    `Media type: ${meta.mediaType}`,
    `Dimensions: ${meta.width}x${meta.height}`,
    `Size: ${formatBytes(published.bytes)}`,
  ].join('\n')

  const toolUseId = ctx.toolUseId
  if (!toolUseId || !deps.preparedImages) {
    // No tool id (or no prepared store): the projection re-verifies from the
    // store on this and every later round. Correct, only bytes are re-read.
    return {
      text,
      content: [
        { type: 'text', text },
        imageRefBlockOf(published.digest, { ...meta, bytes: published.bytes }),
      ],
    }
  }
  let prepared: ReturnType<PreparedImageStore['reserve']>
  try {
    prepared = deps.preparedImages.reserve(toolUseId, attachment, attempt.reservation)
  } catch (err) {
    ledger.release(attempt.reservation)
    throw new ToolInputError(err instanceof Error ? err.message : String(err))
  }
  try {
    deps.preparedImages.complete(prepared, imageModelBlockOf(meta.mediaType, input.bytes.toString('base64')))
    return {
      text,
      content: [
        { type: 'text', text },
        imageRefBlockOf(published.digest, { ...meta, bytes: published.bytes }),
      ],
    }
  } catch (err) {
    deps.preparedImages.release(toolUseId)
    throw err
  }
}

/** A new PDF occurrence: gate, cap, magic, request-media room, then the
 *  prepared document handoff. `context` is the model-visible provenance line
 *  the document block carries (upload id vs working-directory file). */
export async function pdfOutcomeFromBytes(
  deps: NativeMediaReadDeps,
  ctx: ToolContext,
  input: { bytes: Buffer; attachment: NativeFileAttachment; context: string },
): Promise<ToolOutcome> {
  const ledger = deps.pdfBudgets
  if (!ledger) {
    throw new ToolInputError('PDF reading is unavailable in this host: no document budget is wired')
  }
  if (deps.pdfDocumentsEnabled && !deps.pdfDocumentsEnabled()) {
    throw new ToolInputError('PDF document reading is disabled for new occurrences')
  }
  if (input.bytes.length > PDF_MAX_BYTES) {
    throw new ToolInputError(`PDF exceeds the ${formatBytes(PDF_MAX_BYTES)} document limit`)
  }
  if (input.bytes.length < 5 || input.bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new ToolInputError('file bytes do not have PDF magic')
  }
  const attachment = input.attachment
  const attempt = ledger.reservePdfBudget(historyKeyOf(ctx), attachment.size, attachment.digest)
  if (!attempt.ok) {
    if (attempt.reason === 'duplicate') {
      return {
        text: `PDF ${attachment.name} is already included in the conversation above (same bytes); refer to it there instead of re-reading it.`,
      }
    }
    throw new ToolInputError(
      `the request media budget of ${PDF_MAX_BASE64_CHARS.toLocaleString('en-US')} base64 characters is exhausted; start a new session or remove earlier media`,
    )
  }
  const text = `Read PDF ${attachment.name}`
  const content: ToolOutcome['content'] = [
    { type: 'text', text },
    { type: 'file', attachment },
  ]
  const toolUseId = ctx.toolUseId
  const preparedPdfs = deps.preparedPdfs
  if (!toolUseId || !preparedPdfs) {
    // No tool id (or no prepared store): the projection re-verifies from the
    // store on this and every later round. Correct, only bytes are re-read.
    return { text, content }
  }
  let prepared: ReturnType<PreparedPdfStore['reserve']>
  try {
    prepared = preparedPdfs.reserve(toolUseId, attachment, attempt.reservation)
  } catch (err) {
    ledger.release(attempt.reservation)
    throw new ToolInputError(err instanceof Error ? err.message : String(err))
  }
  try {
    preparedPdfs.complete(prepared, pdfDocumentBlockOf(attachment, input.bytes, input.context))
  } catch (err) {
    preparedPdfs.release(toolUseId)
    throw err
  }
  return { text, content }
}

/** Name used for a working-directory file result: the basename, never the
 *  absolute path (paths stay out of model-visible text). */
export function mediaDisplayName(absolutePath: string): string {
  return basename(absolutePath)
}
