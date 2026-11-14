import type { ProviderProfile } from '../../config.js'
import { AnthropicModelDiscovery } from './model-discovery.js'

export const DEFAULT_CONTEXT_WINDOW = 200_000

const SUCCESS_TTL_MS = 5 * 60_000
const FAILURE_COOLDOWN_MS = 30_000

export interface NativeModelRoute {
  profile: ProviderProfile
  providerId: string
  baseUrl: string
  model: string
  api: 'anthropic-messages'
  credentials: () => { baseUrl: string; authToken: string }
}

export interface NativeModelContext {
  contextWindow: number
  source: 'override' | 'endpoint' | 'fallback'
}

export interface NativeModelDiscovery {
  retrieve(route: NativeModelRoute): Promise<number | undefined>
}

interface CacheEntry {
  lastGood?: number
  expiresAt: number
  nextRetryAt: number
  inFlight?: Promise<number | undefined>
}

function isContextWindow(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function fallback(): NativeModelContext {
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, source: 'fallback' }
}

export class NativeModelContextResolver {
  private readonly discovery: NativeModelDiscovery
  private readonly now: () => number
  private readonly profiles = new WeakMap<ProviderProfile, Map<string, CacheEntry>>()

  constructor(opts: { discovery?: NativeModelDiscovery; now?: () => number } = {}) {
    this.discovery = opts.discovery ?? new AnthropicModelDiscovery()
    this.now = opts.now ?? Date.now
  }

  async resolve(route: NativeModelRoute): Promise<NativeModelContext> {
    const override = route.profile.modelContextWindows?.[route.model]
    if (override !== undefined && isContextWindow(override)) {
      return { contextWindow: override, source: 'override' }
    }
    if (route.api !== 'anthropic-messages') return fallback()

    let entries = this.profiles.get(route.profile)
    if (!entries) {
      entries = new Map()
      this.profiles.set(route.profile, entries)
    }
    const key = JSON.stringify([route.baseUrl, route.model])
    let entry = entries.get(key)
    if (!entry) {
      entry = { expiresAt: 0, nextRetryAt: 0 }
      entries.set(key, entry)
    }

    const now = this.now()
    if (entry.lastGood !== undefined) {
      if (now < entry.expiresAt || now < entry.nextRetryAt) {
        return { contextWindow: entry.lastGood, source: 'endpoint' }
      }
      if (!entry.inFlight) void this.startQuery(route, entry)
      return { contextWindow: entry.lastGood, source: 'endpoint' }
    }

    if (now < entry.nextRetryAt) return fallback()
    const value = await (entry.inFlight ?? this.startQuery(route, entry))
    return value === undefined
      ? fallback()
      : { contextWindow: value, source: 'endpoint' }
  }

  private startQuery(route: NativeModelRoute, entry: CacheEntry): Promise<number | undefined> {
    const request = Promise.resolve().then(() => this.discovery.retrieve(route))
    const flight = request.then(
      (value) => {
        const confirmed = value !== undefined && isContextWindow(value) ? value : undefined
        if (entry.inFlight === flight) {
          if (confirmed === undefined) {
            entry.nextRetryAt = this.now() + FAILURE_COOLDOWN_MS
          } else {
            entry.lastGood = confirmed
            entry.expiresAt = this.now() + SUCCESS_TTL_MS
            entry.nextRetryAt = 0
          }
          entry.inFlight = undefined
        }
        return confirmed
      },
      () => {
        if (entry.inFlight === flight) {
          entry.nextRetryAt = this.now() + FAILURE_COOLDOWN_MS
          entry.inFlight = undefined
        }
        return undefined
      },
    )
    entry.inFlight = flight
    return flight
  }
}
