// Helpers shared by the resource providers.

import type { ResourceFrame } from '../registry'

export function failure(code: string, message: string): ResourceFrame<never> {
  return { ok: false, failure: { code, message } }
}