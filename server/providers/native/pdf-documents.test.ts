import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  assignPdfModelForms,
  PDF_MAX_BASE64_CHARS,
  PDF_MAX_BYTES,
  PdfBudgetLedger,
  PreparedPdfStore,
  type PdfDocumentBlock,
} from './pdf-documents.js'
import type { NativeFileAttachment, NativeLogEvent } from './session-log/format.js'

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

function fileBlock(attachment: NativeFileAttachment) {
  return { type: 'file', attachment }
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

  it('rebuilds main and sidechain partitions from the post-compact floor only', () => {
    const oldDigest = digestOf('old')
    const currentDigest = digestOf('current')
    const events = [
      {
        seq: 0, type: 'user', uuid: 'old', session_id: 's', parent_tool_use_id: null, timestamp: 't',
        message: { role: 'user', content: [fileBlock(pdf({ digest: oldDigest, modelForm: 'pdf-document' }))] },
      },
      { seq: 1, type: 'session/compact', text: 'summary', context: 'context', uuid: 'c', timestamp: 't' },
      {
        seq: 2, type: 'user', uuid: 'main', session_id: 's', parent_tool_use_id: null, timestamp: 't',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'main-read', content: [fileBlock(pdf({ digest: currentDigest, modelForm: 'pdf-document' }))] }] },
      },
      {
        seq: 3, type: 'user', uuid: 'agent', session_id: 's', parent_tool_use_id: 'agent-1', timestamp: 't',
        message: { role: 'user', content: [fileBlock(pdf({ digest: currentDigest, modelForm: 'pdf-document' }))] },
      },
    ] as NativeLogEvent[]
    const ledger = new PdfBudgetLedger()
    ledger.rebuildFromEvents(events)
    expect(ledger.reservePdfBudget('main', 3, oldDigest).ok).toBe(true)
    expect(ledger.reservePdfBudget('main', 3, currentDigest)).toMatchObject({ ok: false, reason: 'duplicate' })
    expect(ledger.reservePdfBudget('agent-1', 3, currentDigest)).toMatchObject({ ok: false, reason: 'duplicate' })
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
