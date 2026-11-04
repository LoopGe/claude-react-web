// Resource registry (docs/resource-tabs-research.md §13).
//
// One provider per address protocol, holder-counted streams keyed by the
// verbatim address. A snapshot is one of none / loading / live / failed; on a
// failure the previous value is retained beside the error (last-good), so a
// transient refetch error does not blank the pane. The last holder's release
// aborts the provider and drops the record — so the record map is bounded by
// the number of simultaneously held addresses (open tabs), not by page
// lifetime; there is deliberately no separate cap (evicting a held record
// would kill a stream a subscriber is still watching).
//
// Deliberately NOT Cordis: plain objects registered by the App-level provider.
// The registry is pure TypeScript so its lifecycle rules are tested without a
// DOM; only `useResource` touches React.

import { parseResourceAddress } from '../../shared/resource-address'
import { formatError } from '../utils/format-error'

export interface ResourceFailure {
  code: string
  message: string
}

export type ResourceFrame<T = unknown> = { ok: true; value: T } | { ok: false; failure: ResourceFailure }

export type ResourceStatus = 'none' | 'loading' | 'live' | 'failed'

export interface ResourceSnapshot<T = unknown> {
  status: ResourceStatus
  /** Retained across a failure (last-good). */
  value?: T
  failure?: ResourceFailure
}

/** Frames the registry turns into stream invalidations. A provider awaits this
 *  to know when to refetch; an empty stream (the Phase 1 default) means the
 *  value is fetched once. */
export type InvalidationSource = (kinds: string[], signal: AbortSignal) => AsyncIterable<unknown>

export interface ResourceProvider<T = unknown> {
  /** Usually an address protocol (`file`, `diff`, …). */
  protocol: string
  open(
    address: string,
    ctx: { signal: AbortSignal; invalidations: InvalidationSource },
  ): AsyncIterable<ResourceFrame<T>>
}

interface Record {
  address: string
  snapshot: ResourceSnapshot
  listeners: Set<() => void>
  holders: number
  controller: AbortController | null
}

const NONE: ResourceSnapshot = { status: 'none' }

async function* emptyInvalidations(
  _kinds: string[],
  _signal: AbortSignal,
): AsyncIterable<never> {
  /* no invalidation source wired */
}

interface Options {
  /** Feeds provider refetches. App wires this to the WS hub; tests inject a
   *  fake stream. Default: empty (fetch once). */
  invalidate?: InvalidationSource
}

export class ResourceRegistry {
  private readonly providers = new Map<string, ResourceProvider>()
  private readonly records = new Map<string, Record>()
  private readonly invalidate: InvalidationSource

  constructor(options: Options = {}) {
    this.invalidate = options.invalidate ?? emptyInvalidations
  }

  register(provider: ResourceProvider): void {
    if (this.providers.has(provider.protocol)) {
      throw new Error(`resource provider already registered for "${provider.protocol}"`)
    }
    this.providers.set(provider.protocol, provider)
  }

  hasProvider(protocol: string): boolean {
    return this.providers.has(protocol)
  }

  /** Stable snapshot object until a frame changes it. */
  getSnapshot = (address: string): ResourceSnapshot => {
    return this.records.get(address)?.snapshot ?? NONE
  }

  /** Subscribe a listener AND hold the stream open (React's subscribe). */
  subscribe = (address: string, listener: () => void): (() => void) => {
    return this.acquire(address, listener)
  }

  /** Hold the stream open without a listener (background tabs / pins). */
  hold = (address: string): (() => void) => {
    return this.acquire(address, null)
  }

  /** Restart a held stream (manual refresh). The current value is kept while
   *  the refreshed fetch is in flight, so the body does not blank. */
  refresh = (address: string): void => {
    const record = this.records.get(address)
    if (!record || record.holders === 0) return
    record.controller?.abort()
    this.start(record)
  }

  private acquire(address: string, listener: (() => void) | null): () => void {
    const record = this.ensure(address)
    if (listener) record.listeners.add(listener)
    record.holders += 1
    if (record.holders === 1) this.start(record)

    let active = true
    return () => {
      if (!active) return
      active = false
      if (listener) record.listeners.delete(listener)
      record.holders -= 1
      if (record.holders === 0) this.stop(record)
    }
  }

  private ensure(address: string): Record {
    const existing = this.records.get(address)
    if (existing) return existing
    const parsed = parseResourceAddress(address)
    const hasProvider = parsed != null && this.providers.has(parsed.protocol)
    const record: Record = {
      address,
      snapshot: hasProvider ? { status: 'loading' } : NONE,
      listeners: new Set(),
      holders: 0,
      controller: null,
    }
    this.records.set(address, record)
    return record
  }

  private start(record: Record): void {
    const parsed = parseResourceAddress(record.address)
    const provider = parsed ? this.providers.get(parsed.protocol) : undefined
    if (!provider) {
      record.snapshot = NONE
      this.emit(record)
      return
    }
    const controller = new AbortController()
    record.controller = controller
    // Keep the last value across a manual refresh (last-good); a fresh start
    // has no value, so this is a no-op there.
    record.snapshot = { status: 'loading', value: record.snapshot.value }
    this.emit(record)

    void (async () => {
      try {
        for await (const frame of provider.open(record.address, {
          signal: controller.signal,
          invalidations: this.invalidate,
        })) {
          if (controller.signal.aborted) break
          record.snapshot = frame.ok
            ? { status: 'live', value: frame.value }
            : { status: 'failed', value: record.snapshot.value, failure: frame.failure }
          this.emit(record)
        }
      } catch (error) {
        if (controller.signal.aborted) return
        record.snapshot = {
          status: 'failed',
          value: record.snapshot.value,
          failure: {
            code: 'resource/error',
            message: formatError(error),
          },
        }
        this.emit(record)
      }
    })()
  }

  private stop(record: Record): void {
    record.controller?.abort()
    record.controller = null
    record.snapshot = NONE
    if (this.records.get(record.address) === record) {
      this.records.delete(record.address)
    }
  }

  private emit(record: Record): void {
    for (const listener of [...record.listeners]) listener()
  }
}