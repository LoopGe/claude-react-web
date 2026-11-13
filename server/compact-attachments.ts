import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { TextDecoder } from 'node:util'
import { AttachmentObjectStore, AttachmentStoreError } from './attachment-object-store.js'
import { resolveAuthorizedAttachment } from './attachment-access.js'
import { HttpError } from './errors.js'
import { createLogger } from './log.js'
import type { UploadStore } from './upload-store.js'
import type { ProviderAttachmentOccurrence } from './providers/types.js'
import type { NativeFileAttachment } from './providers/native/session-log/format.js'
import {
  loadPdfDocument,
  PDF_MAX_BASE64_CHARS,
  PDF_MAX_BYTES,
  pdfBase64Length,
} from './providers/native/pdf-documents.js'

const log = createLogger('compact-attachments')

export const COMPACT_TEXT_FILE_BYTES = 65_536
export const COMPACT_TEXT_TOTAL_BYTES = 262_144

interface CompactAttachmentOptions {
  uploadStore: UploadStore
  stateDir: string
  signal?: AbortSignal
}

export interface CompactAttachmentContent {
  content: unknown[]
  hasAttachments: boolean
  hasNativeMedia: boolean
}

type PublicAttachment = Pick<NativeFileAttachment, 'id' | 'name' | 'size' | 'digest'>

interface ProjectableFile {
  kind: 'file'
  attachment: NativeFileAttachment | PublicAttachment
  resolved: boolean
}

interface ProjectableImage {
  kind: 'image'
  block: unknown
}

type ProjectableBlock = ProjectableFile | ProjectableImage

interface TextSelection {
  selected: boolean
  maxBytes: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFileBlock(value: unknown): value is { type: 'file'; attachment: PublicAttachment } {
  return isObject(value) && value.type === 'file' && isObject(value.attachment)
}

function isImageBlock(value: unknown): boolean {
  return isObject(value) && value.type === 'image'
}

function samePublicAttachment(a: PublicAttachment, b: PublicAttachment): boolean {
  return a.id === b.id && a.digest === b.digest
}

function occurrenceKey(messageUuid: string, blockPath: readonly number[]): string {
  return `${messageUuid}\0${blockPath.join(',')}`
}

function compactSafeHandle(attachment: PublicAttachment, status: string): string {
  return [
    `Name: ${attachment.name}`,
    `Upload id: ${attachment.id}`,
    `Size: ${attachment.size} bytes`,
    `Digest: ${attachment.digest.slice(0, 8)}`,
    status,
    `If AttachmentRead is available in a later turn, call it with ${JSON.stringify({ id: attachment.id })} to read this attachment; do not guess at its bytes or ask for a registry path.`,
  ].join('\n')
}

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

function nativeFileBlock(attachment: NativeFileAttachment): { type: 'file'; attachment: NativeFileAttachment } {
  return { type: 'file', attachment: { ...attachment } }
}

/** Rebuild just the attachment/image positions from one public message. Nested
 * occurrences are inserted back into tool_result content at their provider
 * paths; no resolved path is ever taken from the public ring. */
function projectableMessages(
  messages: readonly SDKMessage[],
  occurrences: readonly ProviderAttachmentOccurrence[],
): ProjectableBlock[][] {
  const byPosition = new Map<string, ProviderAttachmentOccurrence>()
  for (const occurrence of occurrences) {
    byPosition.set(occurrenceKey(occurrence.messageUuid, occurrence.blockPath), occurrence)
  }
  const output: ProjectableBlock[][] = []

  for (const message of messages) {
    if (message.type !== 'user') continue
    const raw = message as unknown as { uuid?: unknown; message?: { content?: unknown } }
    if (typeof raw.uuid !== 'string' || !Array.isArray(raw.message?.content)) continue
    const uuid = raw.uuid
    const content = raw.message.content as unknown[]
    const projectable: ProjectableBlock[] = []
    const nested = new Map<number, ProviderAttachmentOccurrence[]>()
    for (const occurrence of occurrences) {
      if (occurrence.messageUuid !== uuid || occurrence.blockPath.length !== 2) continue
      const outer = occurrence.blockPath[0]
      const entries = nested.get(outer) ?? []
      entries.push(occurrence)
      nested.set(outer, entries)
    }

    for (let outerIndex = 0; outerIndex < content.length; outerIndex++) {
      const outer = content[outerIndex]
      if (isFileBlock(outer)) {
        const occurrence = byPosition.get(occurrenceKey(uuid, [outerIndex]))
        if (occurrence && samePublicAttachment(outer.attachment, occurrence.attachment)) {
          projectable.push({ kind: 'file', attachment: occurrence.attachment, resolved: true })
        } else {
          // A public block without an exact provider join remains a reference.
          // Never rediscover it by filename: only UUID+blockPath authorizes bytes.
          projectable.push({ kind: 'file', attachment: { ...outer.attachment }, resolved: false })
        }
        continue
      }
      if (isImageBlock(outer)) {
        projectable.push({ kind: 'image', block: structuredClone(outer) })
        continue
      }
      if (!isObject(outer) || outer.type !== 'tool_result' || !Array.isArray(outer.content)) continue
      const inner = [...outer.content]
      const occurrencesForResult = (nested.get(outerIndex) ?? [])
        .sort((a, b) => a.blockPath[1] - b.blockPath[1])
      for (const occurrence of occurrencesForResult) {
        const innerIndex = occurrence.blockPath[1]
        const replacement = nativeFileBlock(occurrence.attachment)
        const current = inner[innerIndex]
        if (isFileBlock(current) && samePublicAttachment(current.attachment, occurrence.attachment)) {
          inner[innerIndex] = replacement
        } else {
          inner.splice(Math.min(innerIndex, inner.length), 0, replacement)
        }
      }
      for (const [innerIndex, block] of inner.entries()) {
        if (isFileBlock(block)) {
          const occurrence = byPosition.get(occurrenceKey(uuid, [outerIndex, innerIndex]))
          if (occurrence && samePublicAttachment(block.attachment, occurrence.attachment)) {
            projectable.push({ kind: 'file', attachment: occurrence.attachment, resolved: true })
          } else {
            projectable.push({ kind: 'file', attachment: { ...block.attachment }, resolved: false })
          }
        } else if (isImageBlock(block)) {
          projectable.push({ kind: 'image', block: structuredClone(block) })
        }
      }
    }
    output.push(projectable)
  }
  return output
}

function imageBase64Chars(block: unknown): number {
  if (!isObject(block) || !isObject(block.source)) return 0
  return block.source.type === 'base64' && typeof block.source.data === 'string'
    ? block.source.data.length
    : 0
}

function selectTextWindows(messages: readonly ProjectableBlock[][]): Map<ProjectableFile, TextSelection> {
  const selections = new Map<ProjectableFile, TextSelection>()
  let remaining = COMPACT_TEXT_TOTAL_BYTES
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const blocks = messages[messageIndex]
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = blocks[blockIndex]
      if (block.kind !== 'file' || !block.resolved) continue
      const attachment = block.attachment as NativeFileAttachment
      if (attachment.mediaType === 'application/pdf') continue
      const maxBytes = Math.min(COMPACT_TEXT_FILE_BYTES, attachment.size, remaining)
      selections.set(block, { selected: remaining > 0 || attachment.size === 0, maxBytes })
      remaining -= maxBytes
    }
  }
  return selections
}

class InvalidCompactUtf8Error extends Error {}

async function hydrateText(
  attachment: NativeFileAttachment,
  maxBytes: number,
  opts: CompactAttachmentOptions,
): Promise<{ text: string; retainedBytes: number }> {
  const resolved = await resolveAuthorizedAttachment(attachment, opts)
  const objects = new AttachmentObjectStore(opts.stateDir)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const signal = opts.signal ?? new AbortController().signal
  let text = ''
  let retainedBytes = 0
  let stopAccepting = false
  try {
    for await (const chunk of objects.readVerified({
      path: resolved.path,
      digest: resolved.digest,
      size: resolved.size,
      signal,
    })) {
      const decoded = decoder.decode(chunk, { stream: true })
      if (stopAccepting || retainedBytes >= maxBytes) continue
      for (const char of decoded) {
        const size = Buffer.byteLength(char, 'utf8')
        if (retainedBytes + size > maxBytes) {
          stopAccepting = true
          break
        }
        text += char
        retainedBytes += size
      }
    }
    const final = decoder.decode()
    if (!stopAccepting && retainedBytes < maxBytes) {
      for (const char of final) {
        const size = Buffer.byteLength(char, 'utf8')
        if (retainedBytes + size > maxBytes) {
          stopAccepting = true
          break
        }
        text += char
        retainedBytes += size
      }
    }
  } catch (err) {
    if (err instanceof TypeError) throw new InvalidCompactUtf8Error()
    throw err
  }
  return { text, retainedBytes }
}

function safeReadReason(err: unknown): string {
  if (err instanceof InvalidCompactUtf8Error) return 'attachment is not valid UTF-8 text'
  if (err instanceof AttachmentStoreError) {
    if (err.code === 'corrupt') return 'attachment failed integrity verification'
    if (err.code === 'missing') return 'uploaded file is missing'
  }
  if (err instanceof HttpError) return err.message
  return 'the uploaded attachment could not be read'
}

async function hydrateTextBlock(
  block: ProjectableFile,
  selection: TextSelection | undefined,
  opts: CompactAttachmentOptions,
): Promise<unknown> {
  const attachment = block.attachment as NativeFileAttachment
  if (!block.resolved) {
    return textBlock(compactSafeHandle(
      attachment,
      'Attachment content was not hydrated: no exact provider occurrence joined this public block.',
    ))
  }
  if (attachment.mediaType === 'application/pdf') {
    return textBlock(compactSafeHandle(
      attachment,
      'PDF content remains in handle form for compact; no document bytes were read.',
    ))
  }
  if (!selection?.selected) {
    return textBlock(compactSafeHandle(
      attachment,
      `Attachment content was not hydrated because the ${COMPACT_TEXT_TOTAL_BYTES.toLocaleString('en-US')}-byte compact text budget was exhausted.`,
    ))
  }
  try {
    const hydrated = await hydrateText(attachment, selection.maxBytes, opts)
    const truncated = hydrated.retainedBytes < attachment.size
    const marker = truncated
      ? `[Attachment content truncated: included ${hydrated.retainedBytes} of ${attachment.size} raw bytes; per-file limit ${COMPACT_TEXT_FILE_BYTES.toLocaleString('en-US')} bytes and request limit ${COMPACT_TEXT_TOTAL_BYTES.toLocaleString('en-US')} bytes.]`
      : `[Attachment content complete: ${attachment.size} raw bytes hydrated.]`
    return textBlock([
      compactSafeHandle(attachment, 'Verified UTF-8 content hydration follows.'),
      hydrated.text,
      marker,
    ].join('\n'))
  } catch (err) {
    log.warn(`compact hydration failed for upload ${attachment.id}: ${err instanceof Error ? err.message : String(err)}`)
    throw new Error(
      `compact attachment read failed for upload ${attachment.id} (${attachment.name}): ${safeReadReason(err)}`,
      { cause: err },
    )
  }
}

async function pdfBlock(
  attachment: NativeFileAttachment,
  opts: CompactAttachmentOptions,
  budget: { used: number; digests: Set<string>; messageUsed: number },
): Promise<{ block: unknown; native: boolean }> {
  const encodedChars = pdfBase64Length(attachment.size)
  if (budget.digests.has(attachment.digest)) {
    return {
      block: textBlock(compactSafeHandle(
        attachment,
        'PDF document omitted from compact because an earlier occurrence has the same digest.',
      )),
      native: false,
    }
  }
  if (attachment.size > PDF_MAX_BYTES
    || budget.used + encodedChars > PDF_MAX_BASE64_CHARS
    || budget.messageUsed + encodedChars > PDF_MAX_BASE64_CHARS) {
    return {
      block: textBlock(compactSafeHandle(
        attachment,
        `PDF document omitted from compact to stay within the ${PDF_MAX_BASE64_CHARS.toLocaleString('en-US')} base64-character merged request budget; no alias bytes were read.`,
      )),
      native: false,
    }
  }
  const signal = opts.signal ?? new AbortController().signal
  const document = await loadPdfDocument(attachment, opts, signal)
  budget.digests.add(attachment.digest)
  budget.used += encodedChars
  budget.messageUsed += encodedChars
  return { block: document, native: true }
}

/** Build the attachment/image half of one compact request. Ordinary transcript
 * text stays in recap's existing budget; these blocks retain merged order.
 * Canonical history and the public rings are never mutated. */
export async function buildCompactAttachmentContent(
  messages: readonly SDKMessage[],
  occurrences: readonly ProviderAttachmentOccurrence[],
  opts: CompactAttachmentOptions,
): Promise<CompactAttachmentContent> {
  const projected = projectableMessages(messages, occurrences)
  const textSelections = selectTextWindows(projected)
  const content: unknown[] = []
  let hasAttachments = false
  let hasNativeMedia = false
  const budget = { used: 0, digests: new Set<string>(), messageUsed: 0 }

  for (const blocks of projected) {
    budget.messageUsed = blocks.reduce(
      (total, block) => total + (block.kind === 'image' ? imageBase64Chars(block.block) : 0),
      0,
    )
    for (const block of blocks) {
      hasAttachments = true
      if (block.kind === 'image') {
        content.push(block.block)
        hasNativeMedia = true
        continue
      }
      const attachment = block.attachment as NativeFileAttachment
      if (block.resolved && attachment.modelForm === 'pdf-document') {
        const pdf = await pdfBlock(attachment, opts, budget)
        content.push(pdf.block)
        if (pdf.native) hasNativeMedia = true
      } else {
        content.push(await hydrateTextBlock(block, textSelections.get(block), opts))
      }
    }
  }
  return { content, hasAttachments, hasNativeMedia }
}
