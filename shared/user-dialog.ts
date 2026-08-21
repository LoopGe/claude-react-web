// User dialogs — canonical shared shapes for the SDK's `onUserDialog` /
// `supportedDialogKinds` surface (blocking dialogs the CLI asks the host to
// render, e.g. the refusal-fallback prompt).
//
// Mirrors shared/elicitation.ts in style: browser-safe (no Node or SDK
// imports) so the server (broker snapshots, REST payloads, WS frames) and
// the client (dialog rendering) instantiate these directly.
//
// The SDK's `UserDialogRequest` is an OPEN string union: `dialogKind` decides
// the payload/result shape and new kinds may appear without a protocol bump.
// Hosts must answer unrecognized kinds with `{ behavior: 'cancelled' }` —
// the server's DialogBroker short-circuits those before parking (see
// SUPPORTED_DIALOG_KINDS below).

/** Dialog kinds this host can genuinely render. The CLI fails closed: a kind
 *  NOT declared here (via Options.supportedDialogKinds at spawn) is never
 *  emitted — the flow behind it degrades to its no-dialog behavior (for
 *  refusal_fallback_prompt, the classic refusal error ends the turn).
 *
 *  Keep this list in sync with what UserDialog.tsx actually renders. New SDK
 *  kinds arriving here unannounced are auto-cancelled server-side, so adding
 *  an entry is purely additive. */
export const SUPPORTED_DIALOG_KINDS: readonly string[] = ['refusal_fallback_prompt']

/** Valid `result` values for the refusal_fallback_prompt dialog (the CLI's
 *  zod enum; anything else makes its safeParse fall back to 'cancelled').
 *  Shared by the decide route's validation and the client's button set. */
export const REFUSAL_FALLBACK_RESULTS: readonly string[] = ['retry_fallback', 'edit_prompt', 'cancelled']

/** A pending user dialog request as shown in the UI.
 *
 *  `id` is minted server-side (the SDK request carries no id field — always
 *  a random UUID) and stays stable across the WS broadcast, the REST
 *  snapshot, and the decide round-trip. Resolving the SDK's `onUserDialog`
 *  promise IS the answer; the id is only a UI-side correlation key. */
export interface UserDialogRequestUi {
  id: string
  /** Which dialog to render — see SUPPORTED_DIALOG_KINDS. */
  dialogKind: string
  /** Dialog-kind-specific data; shape defined per kind. Passed through
   *  opaquely — narrow defensively with a per-kind parser (see
   *  parseRefusalFallbackPayload). */
  payload: Record<string, unknown>
  /** Present when the dialog is tied to a tool invocation (same value as
   *  the `toolUseID` passed to canUseTool). */
  toolUseID?: string
  createdAt: number
}

/** The host's answer to a UserDialogRequest. Mirrors the SDK's
 *  UserDialogResult: on `cancelled` the CLI applies the dialog's default
 *  behavior. */
export type UserDialogDecision =
  | { behavior: 'completed'; result: unknown }
  | { behavior: 'cancelled' }

/** Defensive narrowing of a refusal_fallback_prompt payload (extracted from
 *  the CLI binary's zod schema; every field is read loosely because the
 *  kind's wire shape can evolve without a protocol bump). */
export interface RefusalFallbackPayload {
  /** Model the refused request was on. */
  originalModel: string
  /** Model the CLI would retry on when the user picks 'retry_fallback'. */
  fallbackModel: string
  /** API-side refusal category, when the server classified one. */
  apiRefusalCategory?: string
  /** Human-readable explanation of the refusal. */
  guidanceText?: string
  /** Wire uuids of the already-streamed messages this refusal concerns —
   *  evicted from the transcript on RESOLUTION (any choice), never on
   *  receipt. Carried on the dialog-resolved frame so every tab evicts. */
  retractedMessageUuids?: string[]
}

/** Narrow an opaque dialog payload into a RefusalFallbackPayload with
 *  per-field fallbacks. Never throws — missing fields render as empty. */
export function parseRefusalFallbackPayload(payload: Record<string, unknown>): RefusalFallbackPayload {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const uuids = Array.isArray(payload.retractedMessageUuids)
    ? payload.retractedMessageUuids.filter((u): u is string => typeof u === 'string')
    : undefined
  return {
    originalModel: str(payload.originalModel) ?? '',
    fallbackModel: str(payload.fallbackModel) ?? '',
    apiRefusalCategory: str(payload.apiRefusalCategory) ?? undefined,
    guidanceText: str(payload.guidanceText) ?? undefined,
    retractedMessageUuids: uuids && uuids.length > 0 ? uuids : undefined,
  }
}
