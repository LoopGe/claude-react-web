/** Failure classification: worker transport, password protection, and generic load errors. */
import { describe, expect, it } from 'vitest'
import { classifyPdfFailure, PdfWorkerFailure } from './pdf-errors'

describe('PDF failure classification', () => {
  it('keeps the native event as the cause of a worker failure', () => {
    const event = new Event('error')
    const failure = new PdfWorkerFailure(event)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.name).toBe('PdfWorkerFailure')
    expect(failure.kind).toBe('worker')
    expect(failure.cause).toBe(event)
    expect(classifyPdfFailure(failure)).toEqual({ kind: 'worker' })
  })

  it('recognizes pdf.js password protection by its error name', () => {
    const error = new Error('No password given')
    error.name = 'PasswordException'
    expect(classifyPdfFailure(error)).toEqual({ kind: 'password' })
  })

  it('carries the message of any other load failure', () => {
    expect(classifyPdfFailure(new Error('Invalid PDF structure'))).toEqual({
      kind: 'failed',
      message: 'Invalid PDF structure',
    })
    expect(classifyPdfFailure('boom')).toEqual({ kind: 'failed', message: 'boom' })
  })
})
