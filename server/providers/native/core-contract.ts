// Neutral core contract for the native provider (design R1, Task 7). This is
// the interface the neutral core (T10's NativeSession) implements and the host
// adapter's wrapNativeCore wraps. It lives core-side (native/) and imports ONLY
// neutral modules — the vocabulary, neutral shared/* refs, and the
// provider-neutral steering vocabulary — so the core can implement it without
// importing the host-side adapter or any SDK / host-contract type. The host
// adapter (native-host-frame-adapter.ts) owns the translation between this
// neutral surface and the SDK-shaped ProviderSessionHandle.
//
// R1 cut: the core owns the neutral turn engine + persistence + emission; the
// adapter owns host-input identity (receivedAt re-keyed onto the neutral uuid),
// the lease callbacks (which wrap the core's neutral persistence outcomes),
// copyConsumedAt / projectFileBlocksForProvider, and the handle translation.
// Host-contract types (AgentUserMessage / AgentMessage / ProviderSessionHandle)
// stay on the wrapper, never here.

import type { RequestMessage } from './vocabulary/message.js'
import type { NativeCoreFrame } from './vocabulary/live-frame.js'
import type { NativeFileAttachment } from '../../../shared/attachment-types.js'
import type { SessionToolProfile } from '../../../shared/tool-profile.js'
import type { SupplementOutcome } from '../steering-format.js'

/** The durable raw-user persistence outcome the core reports per prompt.
 *  `appended` converts an attachment deletion lease to a log reference;
 *  `failed` releases an abandoned prompt. A retryable pre-append failure emits
 *  no outcome (the lease is retained until append or withdrawal). */
export type NativePersistenceOutcome = 'appended' | 'failed'

/** The drain context (T10 fix Q1). `'withdrawal'` abandons the queued prompts
 *  (fire terminal 'failed' → release pairing + send lease); `'transfer'` moves
 *  them to a respawned session (release pairing silently, preserve the send
 *  lease across the re-enqueue). */
export type NativeDrainMode = 'withdrawal' | 'transfer'

/** Neutral attachment occurrence (full-log, for compact hydration). Structurally
 *  identical to the host's ProviderAttachmentOccurrence; defined here so the
 *  core contract carries no host-contract import. `blockPath` is [contentIndex]
 *  for direct user content, [outerContentIndex, innerContentIndex] for a nested
 *  tool-result file. */
export interface NativeAttachmentOccurrence {
  messageUuid: string
  blockPath: readonly number[]
  attachment: NativeFileAttachment
}

/** Neutral interrupt receipt: the neutral uuids of user turns the core dropped
 *  from its own queue because the interrupt carried `cancelQueued`. The adapter
 *  maps these back to host uuids for the manager's withdrawal accounting. */
export interface NativeInterruptReceipt {
  cancelledQueued?: string[]
}

/** Neutral effective settings the NEXT main-thread turn will use. */
export interface NativeEffectiveSettings {
  model: string
  permissionMode?: string
  effortLevel?: string
  agent: string | null
}

/** Neutral pre-persona base values for rebuilding the same base configuration
 *  on a conversation reset. Every field is present (including explicit
 *  undefined) — the manager must not substitute effective values. */
export interface NativeResetBaseSettings {
  model: string
  permissionMode: string | undefined
  effortLevel: string | undefined
  skills: string[] | 'all' | undefined
  toolProfile: SessionToolProfile | undefined
}

/** The neutral core surface. `messages` is the live emission channel
 *  (NativeCoreFrame); input arrives as neutral RequestMessage via enqueue /
 *  enqueueControl; the persistence-outcome callbacks are assignable slots the
 *  adapter wires to translating functions. Control reads / switches are typed
 *  neutrally (string args, unknown / neutral returns) — the adapter delegates
 *  them straight through to the SDK-shaped handle. */
export interface NativeSessionCore {
  /** The session id stamped on every projected live frame envelope. */
  readonly sessionId: string
  /** Live neutral emission: assistant bundles, raw passthrough events, and the
   *  live-only operational frames. The adapter projects each to an SDK frame. */
  readonly messages: AsyncIterable<NativeCoreFrame>
  /** Enqueue a neutral user turn (starts a turn when the pump consumes it). */
  enqueue(msg: RequestMessage): void
  /** Enqueue a neutral control message (joins the conversation without starting
   *  a turn — the compact hand-off seed). */
  enqueueControl(msg: RequestMessage): void
  /** Remove and return queued neutral user turns not yet consumed. The drain
   *  MODE decides the terminal outcome (T10 fix Q1):
   *  - `'withdrawal'` (default): the prompts are ABANDONED (interrupt cancelQueued
   *    / clearQueued). The core fires a terminal `'failed'` persistence outcome
   *    per entry, so the adapter releases the host↔neutral pairing AND the host
   *    lease callback releases the manager's attachment send lease.
   *  - `'transfer'`: the prompts are MOVED to a respawned session (the manager's
   *    respawnInPlace drain → re-enqueue). The core fires NO outcome — the adapter
   *    releases the pairing SILENTLY and the manager's send lease is PRESERVED
   *    across the transfer (the re-enqueue never re-acquires it). The manager
   *    owns the lease decision for this path (it also releases the lease itself
   *    on the withdrawal leg-1 drain and on failed-resume abandonment).
   *  The adapter maps each drained message back to its host AgentUserMessage. */
  drainQueued(mode?: NativeDrainMode): RequestMessage[]
  /** Drop queued neutral user turns (withdrawal); returns the count dropped. */
  clearQueued(): number
  readonly queueDepth: number
  readonly closed: boolean
  readonly abortSignal: AbortSignal
  /** Resolves when the core's execution actually exits. Native runs in-process,
   *  so this resolves immediately; never rejects. */
  readonly processExited: Promise<unknown>
  readonly processRealExit?: Promise<unknown>
  /** True while a pre-append failure has parked the head prompt and paused the
   *  turn loop (the durable-retry pause). */
  readonly awaitingDurableRetry?: boolean

  /** Neutral persistence-outcome callbacks. The adapter assigns translating
   *  functions that look up the paired host message and fire the host lease
   *  callbacks (copyConsumedAt bridges the consumption stamp). */
  onUserMessageConsumed?: (msg: RequestMessage) => void
  onUserMessagePersistence?: (msg: RequestMessage, outcome: NativePersistenceOutcome) => void
  onSupplementDelivered?: (uuid: string, outcome: SupplementOutcome) => void

  /** Mid-run steering (neutral): admit a supplement while a turn is live; drain
   *  undelivered entries; close admission at turn end. */
  enqueueSupplement?(entry: { uuid: string; text: string }): boolean
  drainSupplements?(): Array<{ uuid: string }>
  noteTurnSettled?(): void
  readonly steeringActive?: boolean

  /** Neutral-typed control reads / switches. */
  compactInPlace?(summary: string, opts: { uuid: string; timestamp: string }): Promise<void>
  seedCompactSummary?(summary: string, opts: { uuid: string; timestamp: string; attachments: readonly NativeFileAttachment[] }): Promise<void>
  getAttachmentOccurrences?(): readonly NativeAttachmentOccurrence[]
  getAttachmentCatalog?(): readonly NativeFileAttachment[]
  getSkillCompactionEntries?(): readonly { afterUserUuid: string; body: string }[]
  getContextUsage?(opts?: { detail?: 'summary' | 'full' }): Promise<unknown>
  getEffectiveSettings?(): NativeEffectiveSettings
  getResetBaseSettings?(): NativeResetBaseSettings
  getUsage?(): Promise<unknown>
  accountInfo?(): Promise<unknown>
  generateTitle?(description: string): Promise<unknown>

  interrupt?(opts?: { cancelQueued?: boolean }): Promise<NativeInterruptReceipt | void>
  abort(): void
  destroy(reason?: string): Promise<void> | void

  backgroundTasks?(toolUseId?: string): Promise<boolean>
  stopTask?(taskId: string): Promise<void>
  setModel?(model?: string): Promise<void>
  setPermissionMode?(mode: string): Promise<void>
  /** Plan-mode entry signal: routes the mode change through the host-bound
   *  callback (the EnterPlanMode tool deps bind to this). A bare core with no
   *  host callback is a no-op. */
  enterPlanMode?(): Promise<void>
  applyFlagSettings?(settings: Record<string, unknown>): Promise<void>
  setMaxThinkingTokens?(tokens: number | null, display?: 'summarized' | 'omitted' | 'highlights' | null): Promise<void>
  supportedModels?(): Promise<unknown>
  supportedCommands?(): Promise<unknown>
  supportedAgents?(): Promise<unknown>
  mcpServerStatus?(): Promise<unknown>
  readMcpResource?(serverName: string, uri: string): Promise<unknown>
  reconnectMcpServer?(name: string): Promise<void>
  toggleMcpServer?(name: string, enabled: boolean): Promise<void>
  setMcpServers?(servers: Record<string, unknown>): Promise<unknown>
  setMcpPermissionModeOverride?(serverName: string, mode: 'default' | 'auto' | null): Promise<{ warning?: string }>
  reloadPlugins?(): Promise<unknown>
  reloadSkills(): Promise<unknown>
  readFile?(path: string, options?: { maxBytes?: number; encoding?: 'utf-8' | 'base64' }): Promise<unknown>
  seedReadState?(path: string, mtime: number): Promise<void>
  listSubagents?(): Promise<string[]>
}