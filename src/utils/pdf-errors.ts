/** Structured PDF failures; the viewer owns the visible wording. */

/** Distinguishes worker startup/transport failures from document parse errors. */
export class PdfWorkerFailure extends Error {
  readonly kind = 'worker'

  /** @param cause - native error or messageerror event, retained for diagnostics. */
  constructor(cause: Event) {
    super(undefined, { cause })
    this.name = 'PdfWorkerFailure'
  }
}

/** The failure kinds the PDF viewer renders distinct messages for. */
export type PdfFailure =
  | { readonly kind: 'worker' }
  | { readonly kind: 'password' }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Map a thrown load/render failure to its viewer-facing kind. Worker transport
 * failures are retryable; password protection is unsupported (no entry UI).
 * @param error - whatever the runtime or pdf.js rejected with.
 * @returns the classified failure.
 */
export function classifyPdfFailure(error: unknown): PdfFailure {
  if (error instanceof PdfWorkerFailure) return { kind: 'worker' }
  if (error instanceof Error && error.name === 'PasswordException') return { kind: 'password' }
  return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
}
