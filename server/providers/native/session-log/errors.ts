// server/providers/native/session-log/errors.ts
//
// The single error type for native session-log storage failures. Callers
// branch on `kind` (e.g. `exists` → resume instead of create, `missing` →
// start fresh) rather than matching message text.

export type NativeSessionStorageErrorKind =
  | 'corrupt'
  | 'unsupported-version'
  | 'exists'
  | 'missing'
  | 'fork-boundary'

export class NativeSessionStorageError extends Error {
  readonly kind: NativeSessionStorageErrorKind
  readonly sessionId: string
  readonly path: string

  constructor(
    kind: NativeSessionStorageErrorKind,
    message: string,
    sessionId: string,
    path: string,
  ) {
    super(message)
    this.name = 'NativeSessionStorageError'
    this.kind = kind
    this.sessionId = sessionId
    this.path = path
  }
}