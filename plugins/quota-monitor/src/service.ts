// Quota Monitor plugin — background service.
//
// Speaks the App Plugin JSON-RPC child protocol over stdio (newline-delimited
// JSON-RPC 2.0), same pattern as plugins/system-stats. On activate it reads
// its configuration, starts a self-scheduling poller that queries every
// configured platform adapter and pushes a `stat-grid` widget payload per
// refresh. The `check` command refreshes immediately and returns a markdown
// quota table in a dialog.
//
// Network paths:
//   - Built-in platforms (Volcengine / Zhipu / Kimi) go through the host's
//     `network.fetch` broker, whose host allowlist is declared in the manifest.
//   - The generic adapter reaches arbitrary user-supplied hosts via a DIRECT
//     node fetch (the plugin is a trusted local program — see generic.ts).
//
// No `@claude-react-web/plugin-api` dependency — the runtime is hand-rolled
// here like the other in-tree plugins; the SDK is a later migration target.

import readline from 'node:readline'
import { volcengineAdapter } from './volcengine.js'
import { zhipuAdapter } from './zhipu.js'
import { kimiAdapter } from './kimi.js'
import { minimaxAdapter } from './minimax.js'
import { zenmuxAdapter } from './zenmux.js'
import { opencodeGoAdapter } from './opencodego.js'
import { genericAdapter } from './generic.js'
import type { HttpClient, HttpRequestOptions, HttpResult, PluginConfig, PlatformAdapter } from './platform.js'
import {
  authErrorSnapshot,
  resolveDisplay,
  toneForUtilization,
  type LastGoodSnapshot,
  type QuotaSnapshot,
} from './quota.js'

const PLUGIN_ID = 'quota-monitor.claude-react-web'
const WIDGET_ID = `${PLUGIN_ID}.overview`

const rl = readline.createInterface({ input: process.stdin })
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function callHost(method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

/** HttpClient backed by the host's audited network.fetch broker. */
const brokerHttp: HttpClient = {
  request: async (opts: HttpRequestOptions): Promise<HttpResult> => {
    const res = (await callHost('network.fetch', {
      url: opts.url,
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      timeoutMs: opts.timeoutMs,
    })) as { status: number; headers: Record<string, string>; body: string }
    return { status: res.status, headers: res.headers, body: res.body }
  },
}

/** HttpClient for the generic adapter — direct node fetch (no broker) so
 *  arbitrary user-configured hosts work. */
const directHttp: HttpClient = {
  request: async (opts: HttpRequestOptions): Promise<HttpResult> => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000)
    try {
      const res = await fetch(opts.url, {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        body: opts.body && opts.method === 'POST' ? opts.body : undefined,
        signal: ctrl.signal,
      })
      const text = await res.text()
      const headers: Record<string, string> = {}
      res.headers.forEach((v, k) => {
        headers[k] = v
      })
      return { status: res.status, headers, body: text }
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err))
    } finally {
      clearTimeout(timer)
    }
  },
}

// ── Configuration ─────────────────────────────────────────────────────

const DEFAULT_CONFIG: PluginConfig = {
  refreshMinutes: 5,
  volcBaseUrl: 'https://ark.cn-beijing.volces.com',
  volcAccessKeyId: '',
  volcSecretAccessKey: '',
  zhipuBaseUrl: 'https://open.bigmodel.cn',
  zhipuApiKey: '',
  kimiApiKey: '',
  minimaxApiKey: '',
  minimaxRegion: 'cn',
  zenmuxUrl: '',
  zenmuxApiKey: '',
  opencodeGoApiKey: '',
  genericName: 'Relay',
  genericUrl: '',
  genericMethod: 'GET',
  genericBearerToken: '',
  showWindows: [],
}

const config: PluginConfig = { ...DEFAULT_CONFIG }

function readNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
}

function readString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v.trim() : fallback
}

function applyConfiguration(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return
  const c = raw as Record<string, unknown>
  config.refreshMinutes = readNumber(c[`${PLUGIN_ID}.refreshMinutes`], DEFAULT_CONFIG.refreshMinutes)
  config.volcBaseUrl = readString(c[`${PLUGIN_ID}.volcBaseUrl`], DEFAULT_CONFIG.volcBaseUrl)
  config.volcAccessKeyId = readString(c[`${PLUGIN_ID}.volcAccessKeyId`], DEFAULT_CONFIG.volcAccessKeyId)
  config.volcSecretAccessKey = readString(c[`${PLUGIN_ID}.volcSecretAccessKey`], DEFAULT_CONFIG.volcSecretAccessKey)
  config.zhipuBaseUrl = readString(c[`${PLUGIN_ID}.zhipuBaseUrl`], DEFAULT_CONFIG.zhipuBaseUrl)
  config.zhipuApiKey = readString(c[`${PLUGIN_ID}.zhipuApiKey`], DEFAULT_CONFIG.zhipuApiKey)
  config.kimiApiKey = readString(c[`${PLUGIN_ID}.kimiApiKey`], DEFAULT_CONFIG.kimiApiKey)
  config.minimaxApiKey = readString(c[`${PLUGIN_ID}.minimaxApiKey`], DEFAULT_CONFIG.minimaxApiKey)
  const minimaxRegion = readString(c[`${PLUGIN_ID}.minimaxRegion`], DEFAULT_CONFIG.minimaxRegion)
  config.minimaxRegion = minimaxRegion === 'intl' ? 'intl' : 'cn'
  config.zenmuxUrl = readString(c[`${PLUGIN_ID}.zenmuxUrl`], DEFAULT_CONFIG.zenmuxUrl)
  config.zenmuxApiKey = readString(c[`${PLUGIN_ID}.zenmuxApiKey`], DEFAULT_CONFIG.zenmuxApiKey)
  config.opencodeGoApiKey = readString(c[`${PLUGIN_ID}.opencodeGoApiKey`], DEFAULT_CONFIG.opencodeGoApiKey)
  config.genericName = readString(c[`${PLUGIN_ID}.genericName`], DEFAULT_CONFIG.genericName) || 'Relay'
  config.genericUrl = readString(c[`${PLUGIN_ID}.genericUrl`], DEFAULT_CONFIG.genericUrl)
  config.genericBearerToken = readString(c[`${PLUGIN_ID}.genericBearerToken`], DEFAULT_CONFIG.genericBearerToken)
  const method = readString(c[`${PLUGIN_ID}.genericMethod`], DEFAULT_CONFIG.genericMethod)
  config.genericMethod = method === 'POST' ? 'POST' : 'GET'
  const windows = c[`${PLUGIN_ID}.showWindows`]
  if (Array.isArray(windows)) {
    config.showWindows = windows.filter((w): w is string => typeof w === 'string')
  } else {
    config.showWindows = []
  }
}

// ── Platform orchestration ────────────────────────────────────────────

/** Adapters + the tag shown in widget rows (generic uses the user's name). */
const ADAPTERS: Array<{ adapter: PlatformAdapter; http: HttpClient; tag(): string }> = [
  { adapter: volcengineAdapter, http: brokerHttp, tag: () => 'Ark' },
  { adapter: zhipuAdapter, http: brokerHttp, tag: () => 'Zhipu' },
  { adapter: kimiAdapter, http: brokerHttp, tag: () => 'Kimi' },
  { adapter: minimaxAdapter, http: brokerHttp, tag: () => 'MiniMax' },
  // zenmux reaches a user-configured gateway host — direct fetch like generic.
  { adapter: zenmuxAdapter, http: directHttp, tag: () => 'ZenMux' },
  { adapter: opencodeGoAdapter, http: brokerHttp, tag: () => 'Go' },
  {
    adapter: genericAdapter,
    http: directHttp,
    tag: () => config.genericName || 'Relay',
  },
]

let latest: Record<string, QuotaSnapshot> = {}
let lastGood: Record<string, LastGoodSnapshot> = {}
let polling = false
let timer: NodeJS.Timeout | null = null
let disposed = false

const WINDOW_ORDER: Array<{ name: string; cfgKey: string; label: string }> = [
  { name: 'five_hour', cfgKey: 'fiveHour', label: '5h' },
  { name: 'weekly', cfgKey: 'weekly', label: 'Week' },
  { name: 'monthly', cfgKey: 'monthly', label: 'Month' },
  { name: 'daily', cfgKey: 'daily', label: 'Day' },
]

function visibleWindowNames(): Set<string> {
  if (config.showWindows.length > 0) {
    return new Set(config.showWindows)
  }
  return new Set(['fiveHour', 'weekly', 'monthly'])
}

function formatBalance(amount: number, currency: string | undefined): string {
  const rounded = Number.isFinite(amount) ? Math.round(amount * 100) / 100 : amount
  return currency ? `${rounded} ${currency}` : String(rounded)
}

function snapshotToWidget(snaps: Array<{ snap: QuotaSnapshot; tag: string }>): Record<string, unknown> {
  const rows: Array<Record<string, unknown>> = []
  const visible = visibleWindowNames()

  if (snaps.length === 0) {
    rows.push({ id: 'status', label: 'Quota', value: 'Configure in settings', tone: 'warn' })
  }

  for (const { snap, tag } of snaps) {
    if (!snap.success) {
      const short =
        snap.credentialStatus === 'expired'
          ? 'Auth error'
          : snap.error
            ? 'Error'
            : 'n/a'
      rows.push({
        id: `${snap.platformId}_status`,
        label: tag,
        value: short,
        tone: 'danger',
      })
      continue
    }
    if (snap.balance !== undefined && snap.balance !== null) {
      rows.push({
        id: `${snap.platformId}_balance`,
        label: tag,
        value: formatBalance(snap.balance.amount, snap.balance.currency),
      })
      continue
    }
    for (const tier of snap.tiers) {
      const order = WINDOW_ORDER.find((w) => w.name === tier.name)
      if (!order || !visible.has(order.cfgKey)) continue
      rows.push({
        id: `${snap.platformId}_${tier.name}`,
        label: `${tag} ${order.label}`,
        value: `${Math.round(tier.utilization)}%`,
        progress: Math.min(1, Math.max(0, tier.utilization / 100)),
        tone: toneForUtilization(tier.utilization),
      })
    }
  }

  if (rows.length === 0) {
    rows.push({ id: 'status', label: 'Quota', value: 'No data', tone: 'warn' })
  }
  return { values: rows }
}

async function emitWidget(): Promise<void> {
  const snaps: Array<{ snap: QuotaSnapshot; tag: string }> = []
  for (const { adapter, tag } of ADAPTERS) {
    const snap = latest[adapter.id]
    if (snap) snaps.push({ snap, tag: tag() })
  }
  send({
    jsonrpc: '2.0',
    method: 'app.event',
    params: { widgetId: WIDGET_ID, payload: snapshotToWidget(snaps) },
  })
}

async function pollAdapter(entry: { adapter: PlatformAdapter; http: HttpClient; tag: () => string }): Promise<void> {
  const { adapter } = entry
  if (disposed) return
  const now = Date.now()

  if (!adapter.isConfigured(config)) {
    delete latest[adapter.id]
    delete lastGood[adapter.id]
    return
  }

  let result: Awaited<ReturnType<PlatformAdapter['query']>>
  try {
    result = await adapter.query(entry.http, config)
  } catch (err) {
    // An adapter that throws (programming error, unexpected shape) must not
    // take down the whole poll cycle — turn it into an error snapshot.
    result = {
      data: null,
      error: { kind: 'soft', message: `Adapter error: ${(err as Error).message}` },
    }
  }
  let snap: QuotaSnapshot
  if (result.error) {
    snap =
      result.error.kind === 'auth'
        ? authErrorSnapshot(adapter.id, adapter.label, result.error.message)
        : {
            platformId: adapter.id,
            platformLabel: adapter.label,
            planKind: null,
            planType: null,
            tiers: [],
            balance: null,
            credentialStatus: 'error',
            error: result.error.message,
            queriedAt: now,
            success: false,
          }
  } else if (result.data) {
    snap = {
      platformId: adapter.id,
      platformLabel: adapter.label,
      ...result.data,
      credentialStatus: 'valid',
      error: null,
      queriedAt: now,
      success: true,
    }
  } else {
    snap = {
      platformId: adapter.id,
      platformLabel: adapter.label,
      planKind: null,
      planType: null,
      tiers: [],
      balance: null,
      credentialStatus: 'error',
      error: 'Quota API returned no data.',
      queriedAt: now,
      success: false,
    }
  }

  const { data, lastGood: nextGood } = resolveDisplay(snap, lastGood[adapter.id] ?? null, now)
  latest[adapter.id] = data
  if (nextGood) lastGood[adapter.id] = nextGood
  else delete lastGood[adapter.id]
}

async function pollOnce(): Promise<void> {
  if (polling || disposed) return
  polling = true
  try {
    await Promise.all(ADAPTERS.map((entry) => pollAdapter(entry)))
    await emitWidget()
  } catch {
    // Last line of defence — never let the poller crash the loop.
  } finally {
    polling = false
  }
}

function startPoller(): void {
  if (timer) clearInterval(timer)
  const minutes = config.refreshMinutes > 0 ? config.refreshMinutes : 0
  if (minutes > 0) {
    timer = setInterval(() => {
      void pollOnce()
    }, minutes * 60 * 1000)
  }
}

// ── Command: quota summary ────────────────────────────────────────────

function tierTable(tiers: QuotaSnapshot['tiers']): string {
  const rows = tiers.map((t) => {
    const usedStr =
      t.used !== undefined && t.quota !== undefined
        ? `${t.used.toLocaleString()} / ${t.quota.toLocaleString()}`
        : '—'
    const resetStr = t.resets_at ? new Date(t.resets_at).toLocaleString() : '—'
    return `| ${t.label} | ${usedStr} | ${Math.round(t.utilization)}% | ${resetStr} |`
  })
  return ['| Window | Used / Quota | Utilization | Resets at |', '|---|---|---|---|', ...rows].join('\n')
}

function formatSnapshotSection(snap: QuotaSnapshot): string {
  const head = `**${snap.platformLabel}**`
  if (!snap.success) {
    return `${head} — error: ${snap.error ?? 'unknown'}`
  }
  if (snap.balance !== undefined && snap.balance !== null) {
    return `${head} — balance: ${formatBalance(snap.balance.amount, snap.balance.currency)}`
  }
  const plan =
    snap.planKind === 'agent'
      ? `Agent Plan (${snap.planType ?? 'unknown'})`
      : snap.planKind === 'coding'
        ? 'Coding Plan'
        : snap.planKind === 'subscription'
          ? 'Subscription'
          : 'No active plan'
  if (snap.tiers.length === 0) return `${head} — ${plan}, no windows`
  return `${head} — ${plan}\n\n${tierTable(snap.tiers)}`
}

async function runCheckCommand(): Promise<unknown> {
  await pollOnce()

  const configured = ADAPTERS.filter(({ adapter }) => adapter.isConfigured(config))
  if (configured.length === 0) {
    return {
      type: 'dialog',
      invocationId: '',
      title: 'Quota Monitor',
      content: {
        kind: 'markdown',
        markdown:
          'No quota platforms configured. Open **Settings → App Plugins → Quota Monitor → Configuration** ' +
          'and fill in credentials for at least one platform (Volcengine AK/SK, Zhipu API key, Kimi API key, or a generic endpoint URL).',
      },
    }
  }

  const sections = configured
    .map(({ adapter }) => latest[adapter.id])
    .filter((s): s is QuotaSnapshot => Boolean(s))
    .map(formatSnapshotSection)

  const markdown =
    sections.length > 0
      ? `# Quota Monitor\n\n${sections.join('\n\n')}\n\n_Last checked ${new Date().toLocaleString()}_`
      : 'No quota data yet. Check again in a moment or verify your platform credentials.'

  return {
    type: 'dialog',
    invocationId: '',
    title: 'Quota Monitor',
    content: { kind: 'markdown', markdown },
  }
}

// ── JSON-RPC loop ─────────────────────────────────────────────────────

const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
  activate: async (params) => {
    applyConfiguration((params as { configuration?: unknown })?.configuration)
    disposed = false
    latest = {}
    lastGood = {}
    startPoller()
    void pollOnce()
    return { ok: true }
  },
  deactivate: async () => {
    disposed = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    return { ok: true }
  },
  executeCommand: async (params) => {
    const p = params as { invocationId?: string }
    const result = await runCheckCommand()
    ;(result as { invocationId: string }).invocationId = p.invocationId ?? ''
    return result
  },
}

rl.on('line', (line) => {
  let msg: {
    jsonrpc?: string
    id?: number
    method?: string
    params?: unknown
    result?: unknown
    error?: { message: string }
  }
  try {
    msg = JSON.parse(line) as typeof msg
  } catch {
    return
  }
  if (!msg || msg.jsonrpc !== '2.0') return
  if (msg.id != null && msg.method == null) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message))
    else p.resolve(msg.result)
    return
  }
  if (msg.method && handlers[msg.method]) {
    Promise.resolve(handlers[msg.method](msg.params)).then(
      (result) => {
        if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id, result: result ?? null })
      },
      (err: Error) => {
        if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } })
      },
    )
  }
})