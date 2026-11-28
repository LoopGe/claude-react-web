import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  assignPdfModelForms,
  PDF_MAX_BASE64_CHARS,
  PDF_MAX_BYTES,
  pdfBase64Length,
  PdfBudgetLedger,
  PreparedPdfStore,
  type PdfDocumentBlock,
} from './pdf-documents.js'
import { neutralEventsOf } from './session-log/neutral-read.js'
import { projectNeutralEventToLegacy } from './session-log/format.js'
import type { NativeFileAttachment, NativeLogEvent } from './session-log/format.js'
import type { NativeSessionEvent } from './vocabulary/session-event.js'
import type { ContentBlock } from './vocabulary/types.js'
import { brandString } from './vocabulary/brand.js'

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function pdf(overrides: Partial<NativeFileAttachment> = {}): NativeFileAttachment {
  const digest = overrides.digest ?? digestOf('pdf')
  return {
    id: 'upload-1',
    name: 'document.bin',
    size: 12,
    digest,
    path: `/registry/${digest}/document.bin`,
    mediaType: 'application/pdf',
    modelForm: 'handle',
    ...overrides,
  }
}

function rawPdf(overrides: Partial<NativeFileAttachment> = {}): NativeFileAttachment {
  const { modelForm: _modelForm, ...raw } = pdf(overrides)
  return raw as NativeFileAttachment
}

function fileBlock(attachment: NativeFileAttachment): { type: 'file'; attachment: NativeFileAttachment } {
  return { type: 'file', attachment }
}

const TS_ISO = '2026-11-23T00:00:00.000Z'
const TS = Date.parse(TS_ISO)

function neutralUser(seq: number, uuid: string, parent: string | null, content: ContentBlock[]): NativeSessionEvent {
  return {
    type: 'user/message',
    seq,
    time: TS,
    parentToolUseId: parent,
    data: { role: 'user', id: brandString<'MessageId'>(uuid), content, source: { kind: 'user' } },
  }
}

function neutralToolResult(seq: number, uuid: string, callId: string, parent: string | null, content: ContentBlock[]): NativeSessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: TS,
    parentToolUseId: parent,
    data: {
      message: {
        role: 'tool',
        id: brandString<'MessageId'>(uuid),
        source: { kind: 'tool', callId: brandString<'ToolCallId'>(callId) },
        toolCallId: brandString<'ToolCallId'>(callId),
        content,
        isError: false,
      },
    },
  }
}

interface PdfPartitionView {
  usedBase64Chars: number
  documentDigests: Set<string>
  imageDigests: Set<string>
}

/** The ledger's private partition map, for the deep-equal behavior pin. */
function partitionsOf(ledger: PdfBudgetLedger): Map<string, PdfPartitionView> {
  return (ledger as unknown as { partitions: Map<string, PdfPartitionView> }).partitions
}

/** The pre-neutralization rebuild, kept verbatim as the behavior-preservation
 *  reference: the neutral rebuild must produce exactly the partitions this
 *  legacy scan produced on the same log's legacy events. */
function legacyPdfPartitions(events: readonly NativeLogEvent[]): Map<string, PdfPartitionView> {
  const isFileBlock = (value: unknown): value is { type: 'file'; attachment: NativeFileAttachment } =>
    typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'file'
    && typeof (value as { attachment?: unknown }).attachment === 'object'
    && (value as { attachment?: unknown }).attachment !== null
  const partitions = new Map<string, PdfPartitionView>()
  const record = (historyKey: string, block: unknown): void => {
    if (!isFileBlock(block) || block.attachment.modelForm !== 'pdf-document') return
    const partition = partitions.get(historyKey) ?? {
      usedBase64Chars: 0,
      documentDigests: new Set<string>(),
      imageDigests: new Set<string>(),
    }
    if (partition.documentDigests.has(block.attachment.digest)) return
    partition.usedBase64Chars += pdfBase64Length(block.attachment.size)
    partition.documentDigests.add(block.attachment.digest)
    partitions.set(historyKey, partition)
  }
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
      record(historyKey, block)
      if (typeof block !== 'object' || block === null) continue
      const candidate = block as { type?: unknown; content?: unknown }
      if (candidate.type !== 'tool_result' || !Array.isArray(candidate.content)) continue
      for (const inner of candidate.content) record(historyKey, inner)
    }
  }
  return partitions
}

describe('PDF model-form assignment', () => {
  it('requires server-observed PDF media type, the size limit, and the new-occurrence config', () => {
    const eligible = rawPdf()
    const ledger = new PdfBudgetLedger()
    const assigned = assignPdfModelForms([fileBlock(eligible)], ledger, true)
    expect(assigned.content).toEqual([fileBlock({ ...eligible, modelForm: 'pdf-document' })])
    expect(assigned.reservations).toHaveLength(1)

    for (const candidate of [
      rawPdf({ id: 'not-magic', mediaType: 'text/plain' }),
      rawPdf({ id: 'too-large', size: PDF_MAX_BYTES + 1 }),
    ]) {
      const result = assignPdfModelForms([fileBlock(candidate)], new PdfBudgetLedger(), true)
      expect((result.content[0] as ReturnType<typeof fileBlock>).attachment.modelForm).toBe('handle')
      expect(result.reservations).toHaveLength(0)
    }

    const disabled = assignPdfModelForms([fileBlock(rawPdf())], new PdfBudgetLedger(), false)
    expect((disabled.content[0] as ReturnType<typeof fileBlock>).attachment.modelForm).toBe('handle')
    expect(disabled.reservations).toHaveLength(0)
  })

  it('never rewrites a persisted document when nativePdfDocuments is later disabled', () => {
    const persisted = pdf({ modelForm: 'pdf-document' })
    const result = assignPdfModelForms([fileBlock(persisted)], new PdfBudgetLedger(), false)
    expect(result.content).toEqual([fileBlock(persisted)])
    expect(result.reservations).toHaveLength(0)
  })

  it('allocates in original block order within the shared image+PDF message budget', () => {
    const first = rawPdf({ id: 'first', digest: digestOf('first'), size: 6 })
    const second = rawPdf({ id: 'second', digest: digestOf('second'), size: 9 })
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'i'.repeat(PDF_MAX_BASE64_CHARS - 8) },
    }
    const result = assignPdfModelForms([fileBlock(second), image, fileBlock(first)], new PdfBudgetLedger(), true)
    const blocks = result.content as Array<ReturnType<typeof fileBlock>>
    // 6 raw bytes encode to 8 chars; 9 raw bytes encode to 12. Original order
    // matters: the later 6-byte PDF fits the remaining 8, the earlier 9 does not.
    expect(blocks[0].attachment.modelForm).toBe('handle')
    expect(blocks[2].attachment.modelForm).toBe('pdf-document')

    const reversed = assignPdfModelForms([fileBlock(first), image, fileBlock(second)], new PdfBudgetLedger(), true)
    const reversedBlocks = reversed.content as Array<ReturnType<typeof fileBlock>>
    expect(reversedBlocks[0].attachment.modelForm).toBe('pdf-document')
    expect(reversedBlocks[2].attachment.modelForm).toBe('handle')
  })
})

describe('PdfBudgetLedger', () => {
  it('synchronously partitions dedup and capacity, with confirm and release', () => {
    const ledger = new PdfBudgetLedger()
    const digest = digestOf('same')
    const main = ledger.reservePdfBudget('main', PDF_MAX_BYTES, digest)
    expect(main.ok).toBe(true)
    expect(ledger.reservePdfBudget('main', PDF_MAX_BYTES, digestOf('other')).ok).toBe(false)
    expect(ledger.reservePdfBudget('main', PDF_MAX_BYTES, digest)).toMatchObject({ ok: false, reason: 'duplicate' })

    const agent = ledger.reservePdfBudget('agent-1', PDF_MAX_BYTES, digest)
    expect(agent.ok).toBe(true)
    if (agent.ok) ledger.confirm(agent.reservation)

    if (main.ok) ledger.release(main.reservation)
    const replacement = ledger.reservePdfBudget('main', PDF_MAX_BYTES, digest)
    expect(replacement.ok).toBe(true)
    if (replacement.ok) ledger.confirm(replacement.reservation)
    // Releasing a confirmed reservation must not erase persisted history.
    if (replacement.ok) ledger.release(replacement.reservation)
    expect(ledger.reservePdfBudget('main', PDF_MAX_BYTES, digestOf('third')).ok).toBe(false)
  })

  it('counts a repeated persisted digest once per partition when rebuilding', () => {
    const repeated = pdf({ digest: digestOf('repeated'), size: PDF_MAX_BYTES, modelForm: 'pdf-document' })
    const events: NativeSessionEvent[] = [
      neutralUser(0, 'main', null, [fileBlock(repeated), fileBlock(repeated)]),
      neutralUser(1, 'agent', 'agent-1', [fileBlock(repeated), fileBlock(repeated)]),
    ]
    const ledger = new PdfBudgetLedger()

    ledger.rebuildFromEvents(events)

    // Behavior pin: deep-equal to the legacy rebuild on the legacy projection.
    expect(partitionsOf(ledger)).toEqual(
      legacyPdfPartitions(events.map((event) => projectNeutralEventToLegacy(event, 's'))),
    )
    expect(ledger.reservePdfBudget('main', 3, digestOf('next-main')).ok).toBe(true)
    expect(ledger.reservePdfBudget('agent-1', 3, digestOf('next-agent')).ok).toBe(true)
  })

  it('rebuilds main and sidechain partitions from the post-compact floor only', () => {
    const oldDigest = digestOf('old')
    const currentDigest = digestOf('current')
    const catalogDigest = digestOf('catalog')
    const handleDigest = digestOf('handle')
    const events: NativeSessionEvent[] = [
      neutralUser(0, 'old', null, [fileBlock(pdf({ digest: oldDigest, modelForm: 'pdf-document' }))]),
      { type: 'session/compact', seq: 1, time: TS, data: { text: 'summary', context: 'context', uuid: 'c', timestamp: TS_ISO } },
      neutralToolResult(2, 'main', 'main-read', null, [fileBlock(pdf({ digest: currentDigest, modelForm: 'pdf-document' }))]),
      neutralUser(3, 'agent', 'agent-1', [fileBlock(pdf({ digest: currentDigest, modelForm: 'pdf-document' }))]),
      // A post-floor hidden catalog and a handle-form occurrence hold no budget.
      { type: 'session/attachments', seq: 4, time: TS, data: { attachments: [pdf({ id: 'cat', digest: catalogDigest, modelForm: 'pdf-document' })], timestamp: TS_ISO } },
      neutralUser(5, 'handle-user', null, [fileBlock(pdf({ id: 'h', digest: handleDigest, modelForm: 'handle' }))]),
    ]
    const ledger = new PdfBudgetLedger()
    ledger.rebuildFromEvents(events)
    expect(partitionsOf(ledger)).toEqual(
      legacyPdfPartitions(events.map((event) => projectNeutralEventToLegacy(event, 's'))),
    )
    expect(ledger.reservePdfBudget('main', 3, oldDigest).ok).toBe(true)
    expect(ledger.reservePdfBudget('main', 3, currentDigest)).toMatchObject({ ok: false, reason: 'duplicate' })
    expect(ledger.reservePdfBudget('agent-1', 3, currentDigest)).toMatchObject({ ok: false, reason: 'duplicate' })
    expect(ledger.reservePdfBudget('main', 3, catalogDigest).ok).toBe(true)
    expect(ledger.reservePdfBudget('main', 3, handleDigest).ok).toBe(true)
  })

  it('rebuilds an unmigrated v1/v2 log identically through the neutralEventsOf fallback (v1/v2 fixture pin)', () => {
    const oldDigest = digestOf('old')
    const sideDigest = digestOf('side')
    const catalogDigest = digestOf('catalog')
    const legacyEvents = [
      {
        seq: 0, type: 'user', uuid: 'old', session_id: 's', parent_tool_use_id: null, timestamp: TS_ISO,
        message: { role: 'user', content: [fileBlock(pdf({ digest: oldDigest, modelForm: 'pdf-document' }))] },
      },
      { seq: 1, type: 'session/compact', text: 'summary', context: 'context', uuid: 'c', timestamp: TS_ISO },
      {
        seq: 2, type: 'user', uuid: 'side-read', session_id: 's', parent_tool_use_id: 'agent-1', timestamp: TS_ISO,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'side-call', content: [fileBlock(pdf({ digest: sideDigest, modelForm: 'pdf-document' }))] }] },
      },
      {
        seq: 3, type: 'user', uuid: 'side-direct', session_id: 's', parent_tool_use_id: 'agent-1', timestamp: TS_ISO,
        message: { role: 'user', content: [fileBlock(pdf({ digest: sideDigest, modelForm: 'pdf-document' })), fileBlock(pdf({ digest: sideDigest, modelForm: 'pdf-document' }))] },
      },
      { seq: 4, type: 'session/attachments', attachments: [pdf({ id: 'cat', digest: catalogDigest, modelForm: 'pdf-document' })], timestamp: TS_ISO },
    ] as NativeLogEvent[]
    const ledger = new PdfBudgetLedger()

    // neutralEvents undefined: the fallback migrates the legacy read view.
    ledger.rebuildFromEvents(neutralEventsOf({ events: legacyEvents }))

    expect(partitionsOf(ledger)).toEqual(legacyPdfPartitions(legacyEvents))
    expect(ledger.reservePdfBudget('main', 3, oldDigest).ok).toBe(true)
    expect(ledger.reservePdfBudget('agent-1', 3, sideDigest)).toMatchObject({ ok: false, reason: 'duplicate' })
    expect(ledger.reservePdfBudget('main', 3, catalogDigest).ok).toBe(true)
  })
})

describe('PreparedPdfStore', () => {
  it('consumes a completed prepared document once and retains confirmed budget', () => {
    const attachment = pdf({ size: 3 })
    const document: PdfDocumentBlock = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' },
      title: attachment.name,
      context: `Upload id: ${attachment.id}`,
    }
    const ledger = new PdfBudgetLedger()
    const store = new PreparedPdfStore(ledger)
    const budget = ledger.reservePdfBudget('main', attachment.size, attachment.digest)
    expect(budget.ok).toBe(true)
    if (!budget.ok) return
    const prepared = store.reserve('tool-1', attachment, budget.reservation)
    store.complete(prepared, document)
    store.confirmPersisted('tool-1')
    expect(store.consume('tool-1', attachment)).toEqual(document)
    expect(store.consume('tool-1', attachment)).toBeUndefined()
    expect(ledger.reservePdfBudget('main', 3, attachment.digest)).toMatchObject({ ok: false, reason: 'duplicate' })
  })

  it('releases unconfirmed budget on clear and caps twenty simultaneous reads before buffering', () => {
    const ledger = new PdfBudgetLedger()
    const store = new PreparedPdfStore(ledger)
    const first = pdf({ id: 'max-0', digest: digestOf('max-0'), size: PDF_MAX_BYTES })
    const budget = ledger.reservePdfBudget('agent-0', first.size, first.digest)
    expect(budget.ok).toBe(true)
    if (!budget.ok) return
    store.reserve('tool-0', first, budget.reservation)

    let rejected = 0
    for (let index = 1; index < 20; index++) {
      const candidate = pdf({ id: `max-${index}`, digest: digestOf(`max-${index}`), size: PDF_MAX_BYTES })
      const reservation = ledger.reservePdfBudget(`agent-${index}`, candidate.size, candidate.digest)
      expect(reservation.ok).toBe(true)
      if (!reservation.ok) continue
      try {
        store.reserve(`tool-${index}`, candidate, reservation.reservation)
      } catch (err) {
        rejected++
        ledger.release(reservation.reservation)
        expect(err).toBeInstanceOf(Error)
        expect((err as Error).message).toMatch(/20 MiB|28,000,000|PreparedPdf/)
      }
    }
    expect(rejected).toBe(19)
    store.clearHistory('agent-0')
    expect(ledger.reservePdfBudget('agent-0', 3, digestOf('after-clear')).ok).toBe(true)
  })

  it('clears one finished history without releasing an active sidechain read', () => {
    const ledger = new PdfBudgetLedger()
    const store = new PreparedPdfStore(ledger)
    const main = pdf({ id: 'main', digest: digestOf('main'), size: 3 })
    const agent = pdf({ id: 'agent', digest: digestOf('agent'), size: 3 })
    const mainBudget = ledger.reservePdfBudget('main', main.size, main.digest)
    const agentBudget = ledger.reservePdfBudget('agent-1', agent.size, agent.digest)
    expect(mainBudget.ok && agentBudget.ok).toBe(true)
    if (!mainBudget.ok || !agentBudget.ok) return
    store.reserve('main-read', main, mainBudget.reservation)
    store.reserve('agent-read', agent, agentBudget.reservation)

    store.clearHistory('main')
    expect(ledger.reservePdfBudget('main', 3, digestOf('next-main')).ok).toBe(true)
    expect(ledger.reservePdfBudget('agent-1', 3, agent.digest)).toMatchObject({ ok: false, reason: 'duplicate' })
    store.clearHistory('agent-1')
    expect(ledger.reservePdfBudget('agent-1', 3, agent.digest).ok).toBe(true)
  })
})
