import { AttachmentObjectStore, AttachmentStoreError } from '../../attachment-object-store.js'
import { resolveAuthorizedAttachment } from '../../attachment-access.js'
import { HttpError } from '../../errors.js'
import type { ResolvedFileAttachment } from '../../agent-message.js'
import type { UploadStore } from '../../upload-store.js'
import type { NativeFileAttachment, NativeLogEvent } from './session-log/format.js'

export const PDF_MAX_BYTES = 20 * 1024 * 1024
export const PDF_MAX_BASE64_CHARS = 28_000_000

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii')

export interface PdfDocumentBlock {
  type: 'document'
  source: {
    type: 'base64'
    media_type: 'application/pdf'
    data: string
  }
  title: string
  context: string
}

export function pdfBase64Length(size: number): number {
  return 4 * Math.ceil(size / 3)
}

type ReservationState = 'pending' | 'confirmed' | 'released'

/** One synchronous budget hold. The ledger owns all state transitions; callers
 * choose confirm at persistence or release on failure/interrupt. */
export class PdfBudgetReservation {
  /** @internal */ _state: ReservationState = 'pending'

  constructor(
    readonly historyKey: string,
    readonly size: number,
    readonly digest: string,
    readonly base64Chars: number,
  ) {}
}

export type PdfBudgetAttempt =
  | { ok: true; reservation: PdfBudgetReservation }
  | { ok: false; reason: 'duplicate' | 'exhausted' }

interface PdfPartition {
  usedBase64Chars: number
  documentDigests: Set<string>
}

function isNativeFileBlock(value: unknown): value is { type: 'file'; attachment: NativeFileAttachment } {
  return typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'file'
    && typeof (value as { attachment?: unknown }).attachment === 'object'
    && (value as { attachment?: unknown }).attachment !== null
}

/** Per-model-history PDF allocation. Pending holds count exactly like confirmed
 * documents, so concurrent readers cannot both observe the same remaining room. */
export class PdfBudgetLedger {
  private readonly partitions = new Map<string, PdfPartition>()

  reservePdfBudget(historyKey: string, size: number, digest: string): PdfBudgetAttempt {
    const partition = this.partitions.get(historyKey) ?? {
      usedBase64Chars: 0,
      documentDigests: new Set<string>(),
    }
    if (partition.documentDigests.has(digest)) return { ok: false, reason: 'duplicate' }
    const base64Chars = pdfBase64Length(size)
    if (partition.usedBase64Chars + base64Chars > PDF_MAX_BASE64_CHARS) {
      return { ok: false, reason: 'exhausted' }
    }
    partition.usedBase64Chars += base64Chars
    partition.documentDigests.add(digest)
    this.partitions.set(historyKey, partition)
    return { ok: true, reservation: new PdfBudgetReservation(historyKey, size, digest, base64Chars) }
  }

  confirm(reservation: PdfBudgetReservation): void {
    if (reservation._state === 'confirmed') return
    if (reservation._state !== 'pending' || !this.partitions.has(reservation.historyKey)) {
      throw new Error('PDF budget reservation is no longer active')
    }
    reservation._state = 'confirmed'
  }

  release(reservation: PdfBudgetReservation): void {
    if (reservation._state !== 'pending') return
    const partition = this.partitions.get(reservation.historyKey)
    if (!partition) throw new Error('PDF budget reservation partition is no longer active')
    partition.usedBase64Chars -= reservation.base64Chars
    partition.documentDigests.delete(reservation.digest)
    reservation._state = 'released'
  }

  /** Rebuild from the same compact floor as model replay. Hidden authorization
   * catalogs do not count; sidechains use their spawning agent tool-use id. */
  rebuildFromEvents(events: readonly NativeLogEvent[]): void {
    this.partitions.clear()
    let floor = 0
    for (let index = events.length - 1; index >= 0; index--) {
      if (events[index].type === 'session/compact') {
        floor = index + 1
        break
      }
    }
    for (let index = floor; index < events.length; index++) {
      const event = events[index]
      if (event.type !== 'user') continue
      const historyKey = event.parent_tool_use_id ?? 'main'
      for (const block of event.message.content) {
        this.recordBlock(historyKey, block)
        if (typeof block !== 'object' || block === null) continue
        const candidate = block as { type?: unknown; content?: unknown }
        if (candidate.type !== 'tool_result' || !Array.isArray(candidate.content)) continue
        for (const inner of candidate.content) this.recordBlock(historyKey, inner)
      }
    }
  }

  private recordBlock(historyKey: string, block: unknown): void {
    if (!isNativeFileBlock(block) || block.attachment.modelForm !== 'pdf-document') return
    const partition = this.partitions.get(historyKey) ?? {
      usedBase64Chars: 0,
      documentDigests: new Set<string>(),
    }
    partition.usedBase64Chars += pdfBase64Length(block.attachment.size)
    partition.documentDigests.add(block.attachment.digest)
    this.partitions.set(historyKey, partition)
  }
}

export interface AssignedPdfModelForms {
  content: unknown[]
  reservations: PdfBudgetReservation[]
}

function imageBase64Chars(content: readonly unknown[]): number {
  let total = 0
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown; source?: { type?: unknown; data?: unknown } }
    if (candidate.type !== 'image' || candidate.source?.type !== 'base64') continue
    if (typeof candidate.source.data === 'string') total += candidate.source.data.length
  }
  return total
}

/** Allocate once, in original block order, before a new raw user occurrence is
 * persisted. Existing modelForm values are history and are never re-selected. */
export function assignPdfModelForms(
  content: readonly unknown[],
  ledger: PdfBudgetLedger,
  nativePdfDocuments: boolean,
): AssignedPdfModelForms {
  const reservations: PdfBudgetReservation[] = []
  let messagePdfBase64 = 0
  const messageImageBase64 = imageBase64Chars(content)
  const projected = content.map((value) => {
    if (!isNativeFileBlock(value)) return value
    const attachment = value.attachment
    if (attachment.modelForm === 'handle' || attachment.modelForm === 'pdf-document') return value
    const base64Chars = pdfBase64Length(attachment.size)
    const eligible = nativePdfDocuments
      && attachment.mediaType === 'application/pdf'
      && attachment.size <= PDF_MAX_BYTES
      && messageImageBase64 + messagePdfBase64 + base64Chars <= PDF_MAX_BASE64_CHARS
    if (!eligible) return { ...value, attachment: { ...attachment, modelForm: 'handle' } }
    const attempt = ledger.reservePdfBudget('main', attachment.size, attachment.digest)
    if (!attempt.ok) return { ...value, attachment: { ...attachment, modelForm: 'handle' } }
    reservations.push(attempt.reservation)
    messagePdfBase64 += base64Chars
    return { ...value, attachment: { ...attachment, modelForm: 'pdf-document' } }
  })
  return { content: projected, reservations }
}

interface PreparedSlot {
  readonly toolUseId: string
  readonly attachment: ResolvedFileAttachment
  readonly budget: PdfBudgetReservation
  readonly base64Chars: number
  document?: PdfDocumentBlock
  persisted: boolean
}

/** Opaque handle for one in-flight AttachmentRead preparation. */
export class PreparedPdfReservation {
  constructor(/** @internal */ readonly _slot: PreparedSlot) {}
}

/** Session-wide backpressure for verified bytes held between AttachmentRead and
 * the immediately following projection. This is independent of history budgets. */
export class PreparedPdfStore {
  private readonly slots = new Map<string, PreparedSlot>()
  private rawBytes = 0
  private base64Chars = 0

  constructor(private readonly ledger: PdfBudgetLedger) {}

  reserve(
    toolUseId: string,
    attachment: ResolvedFileAttachment,
    budget: PdfBudgetReservation,
  ): PreparedPdfReservation {
    if (!toolUseId) throw new Error('PreparedPdf requires a tool_use id')
    if (this.slots.has(toolUseId)) throw new Error(`PreparedPdf already exists for tool_use: ${toolUseId}`)
    const encodedChars = pdfBase64Length(attachment.size)
    if (this.rawBytes + attachment.size > PDF_MAX_BYTES
      || this.base64Chars + encodedChars > PDF_MAX_BASE64_CHARS) {
      throw new Error('PreparedPdf session budget exceeded: 20 MiB raw bytes or 28,000,000 base64 characters')
    }
    const slot: PreparedSlot = {
      toolUseId,
      attachment: { ...attachment },
      budget,
      base64Chars: encodedChars,
      persisted: false,
    }
    this.slots.set(toolUseId, slot)
    this.rawBytes += attachment.size
    this.base64Chars += encodedChars
    return new PreparedPdfReservation(slot)
  }

  complete(reservation: PreparedPdfReservation, document: PdfDocumentBlock): void {
    const slot = reservation._slot
    if (this.slots.get(slot.toolUseId) !== slot) throw new Error('PreparedPdf reservation is no longer active')
    if (slot.document) throw new Error(`PreparedPdf is already complete for tool_use: ${slot.toolUseId}`)
    if (document.source.data.length !== slot.base64Chars) {
      throw new Error(`PreparedPdf base64 length mismatch for tool_use: ${slot.toolUseId}`)
    }
    slot.document = document
  }

  confirmPersisted(toolUseId: string): void {
    const slot = this.slots.get(toolUseId)
    if (!slot || slot.persisted) return
    this.ledger.confirm(slot.budget)
    slot.persisted = true
  }

  consume(toolUseId: string, attachment: ResolvedFileAttachment): PdfDocumentBlock | undefined {
    const slot = this.slots.get(toolUseId)
    if (!slot) return undefined
    if (!slot.persisted || !slot.document) throw new Error(`PreparedPdf is not ready for tool_use: ${toolUseId}`)
    if (slot.attachment.id !== attachment.id || slot.attachment.digest !== attachment.digest) {
      throw new Error(`PreparedPdf attachment mismatch for tool_use: ${toolUseId}`)
    }
    const document = slot.document
    this.remove(slot)
    return document
  }

  release(toolUseId: string): void {
    const slot = this.slots.get(toolUseId)
    if (!slot) return
    if (!slot.persisted) this.ledger.release(slot.budget)
    this.remove(slot)
  }

  clearHistory(historyKey: string): void {
    for (const slot of [...this.slots.values()]) {
      if (slot.budget.historyKey === historyKey) this.release(slot.toolUseId)
    }
  }

  private remove(slot: PreparedSlot): void {
    this.slots.delete(slot.toolUseId)
    this.rawBytes -= slot.attachment.size
    this.base64Chars -= slot.base64Chars
  }
}

export class PdfReadError extends Error {
  constructor(readonly reason: 'size' | 'magic', message: string) {
    super(message)
    this.name = 'PdfReadError'
  }
}

function documentBlock(attachment: ResolvedFileAttachment, bytes: Buffer): PdfDocumentBlock {
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: bytes.toString('base64'),
    },
    title: attachment.name,
    context: `Upload id: ${attachment.id}`,
  }
}

/** Read an already authorized registry path once. Bytes are bounded before
 * buffering, and neither magic success nor base64 is exposed before EOF digest
 * verification has succeeded. */
export async function readAuthorizedPdfDocument(
  attachment: ResolvedFileAttachment,
  stateDir: string,
  signal: AbortSignal,
): Promise<PdfDocumentBlock> {
  if (attachment.size > PDF_MAX_BYTES) {
    throw new PdfReadError('size', 'PDF exceeds the 20 MiB document limit')
  }
  const objects = new AttachmentObjectStore(stateDir)
  const chunks: Buffer[] = []
  let retained = 0
  for await (const chunk of objects.readVerified({
    path: attachment.path,
    digest: attachment.digest,
    size: attachment.size,
    signal,
  })) {
    if (retained + chunk.byteLength > PDF_MAX_BYTES) {
      throw new PdfReadError('size', 'PDF exceeds the 20 MiB document limit')
    }
    chunks.push(chunk as Buffer)
    retained += chunk.byteLength
  }
  const bytes = Buffer.concat(chunks, retained)
  if (bytes.length < PDF_MAGIC.length || !bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new PdfReadError('magic', 'attachment bytes do not have PDF magic')
  }
  return documentBlock(attachment, bytes)
}

export async function loadPdfDocument(
  attachment: ResolvedFileAttachment,
  opts: { uploadStore: UploadStore; stateDir: string },
  signal: AbortSignal,
): Promise<PdfDocumentBlock> {
  const resolved = await resolveAuthorizedAttachment(attachment, opts)
  return readAuthorizedPdfDocument(resolved, opts.stateDir, signal)
}

/** Model-safe failure text. Raw filesystem errors stay with the caller's
 * scoped logger; neither absolute paths nor base64 enter model history. */
export function safePdfReadReason(err: unknown): string {
  if (err instanceof PdfReadError) {
    return err.reason === 'size' ? 'PDF exceeds the 20 MiB document limit' : 'attachment bytes do not have PDF magic'
  }
  if (err instanceof AttachmentStoreError) {
    if (err.code === 'corrupt') return 'attachment failed integrity verification'
    if (err.code === 'missing') return 'uploaded file is missing'
    if (err.code === 'too-large') return 'PDF exceeds the 20 MiB document limit'
  }
  if (err instanceof HttpError) return err.message
  return 'the uploaded PDF could not be read'
}
