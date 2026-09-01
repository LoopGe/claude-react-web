// Volcengine Ark quota adapter — ported from cc-switch's
// src-tauri/src/services/coding_plan.rs (the volcengine section), a
// field-tested implementation against the control-plane OpenAPI.
//
// Key facts that MUST not be "simplified" away:
//   - The quota API lives on the CONTROL-plane gateway `open.volcengineapi.com`,
//     NOT the data-plane inference host `ark.<region>.volces.com`. It is a
//     POST against `/?Action=…&Version=2024-01-01&Region=<region>`.
//   - Auth is Volcengine Signature V4 with ACCOUNT-LEVEL AccessKey ID/Secret.
//     The inference bearer key is rejected by the gateway (400 InvalidAuthorization).
//   - The signature algorithm is an AWS-SigV4 VARIANT with three fatal
//     differences from standard SigV4:
//       1. canonical headers + SignedHeaders use a FIXED order
//          `host;x-date;x-content-sha256;content-type` (NOT alphabetical);
//       2. algorithm string is `HMAC-SHA256` (no `AWS4` prefix), credential
//          scope ends with `request` (not `aws4_request`);
//       3. signing key kDate = HMAC(SK, date) — the secret is NOT prefixed
//          with `AWS4`.
//     service = `ark`, method = POST, body = empty.

import { createHmac, createHash } from 'node:crypto'
import {
  TIER_FIVE_HOUR,
  TIER_WEEKLY,
  TIER_MONTHLY,
  WINDOW_LABELS,
  epochToIso,
  num,
  type HttpClient,
  type PlatformAdapter,
  type PlatformQueryData,
  type PlatformQueryResult,
  type QuotaTier,
} from './platform.js'

const OPENAPI_HOST = 'open.volcengineapi.com'
const API_VERSION = '2024-01-01'
const SERVICE = 'ark'
const CONTENT_TYPE = 'application/json; charset=utf-8'
const SIGNED_HEADERS = 'host;x-date;x-content-sha256;content-type'

const hmac = (key: Uint8Array, data: string | Uint8Array): Uint8Array =>
  createHmac('sha256', key).update(data).digest()

const sha256hex = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')

/** RFC3986 encode (unreserved chars pass through, everything else %XX). */
function uriEncode(input: string): string {
  return encodeURIComponent(input).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

/** Canonical query string: the three fixed params sorted by key. The SAME
 *  string is used for signing and for the actual request URL. */
export function canonicalQuery(action: string, region: string): string {
  const pairs: Array<[string, string]> = [
    ['Action', action],
    ['Region', region],
    ['Version', API_VERSION],
  ]
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return pairs.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&')
}

export interface VolcSignature {
  authorization: string
  xDate: string
  contentSha256: string
}

/** Sign one OpenAPI call. `now` is injectable for deterministic tests. */
export function signV4(
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  action: string,
  body: Uint8Array,
  now: Date = new Date(),
): VolcSignature {
  const xDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') // 20260901T001500Z
  const shortDate = xDate.slice(0, 8)
  const contentSha256 = sha256hex(body)

  // Fixed-order canonical headers — Volcengine-specific, DO NOT sort.
  const canonicalHeaders =
    `host:${OPENAPI_HOST}\n` +
    `x-date:${xDate}\n` +
    `x-content-sha256:${contentSha256}\n` +
    `content-type:${CONTENT_TYPE}\n`
  const canonicalRequest =
    `POST\n/\n${canonicalQuery(action, region)}\n` +
    `${canonicalHeaders}\n${SIGNED_HEADERS}\n${contentSha256}`

  const credentialScope = `${shortDate}/${region}/${SERVICE}/request`
  const stringToSign =
    `HMAC-SHA256\n${xDate}\n${credentialScope}\n` + sha256hex(canonicalRequest)

  // Key derivation: kDate = HMAC(SK, date) — NO `AWS4` prefix on the secret.
  const kDate = hmac(Buffer.from(secretAccessKey, 'utf8'), shortDate)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, SERVICE)
  const kSigning = hmac(kService, 'request')
  const signature = Buffer.from(hmac(kSigning, stringToSign)).toString('hex')

  return {
    authorization:
      `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    xDate,
    contentSha256,
  }
}

/** Derive the OpenAPI region from a data-plane base URL (ark.cn-beijing.volces.com
 *  → cn-beijing). Falls back to cn-beijing when unrecognizable. */
export function deriveRegion(baseUrl: string): string {
  const rest = baseUrl.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? ''
  const part = rest.split('.').find((p) => p.startsWith('cn-') || p.startsWith('ap-'))
  return part ?? 'cn-beijing'
}

function isAuthErrorCode(code: string): boolean {
  const c = code.toLowerCase()
  return (
    c.includes('auth') ||
    c.includes('signature') ||
    c.includes('accessdenied') ||
    c.includes('denied') ||
    c.includes('unauthorized') ||
    c.includes('forbidden') ||
    c.includes('credential') ||
    c.includes('token')
  )
}

function responseError(body: unknown): { code: string; message: string } | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const err = (b.ResponseMetadata as Record<string, unknown> | undefined)?.Error ?? b.Error
  if (!err || typeof err !== 'object') return null
  const e = err as Record<string, unknown>
  const code = typeof e.Code === 'string' ? e.Code : ''
  const message = typeof e.Message === 'string' ? e.Message : ''
  if (!code && !message) return null
  return { code, message }
}

/** Parse GetAFPUsage Result → tiers. Absolute Quota/Used windows; skip
 *  Quota<=0 (not subscribed) and skip AFPDaily (hidden in the official
 *  console — its Quota is a historical default, not an enforced limit). */
export function parseAfpTiers(result: unknown): QuotaTier[] {
  const tiers: QuotaTier[] = []
  if (!result || typeof result !== 'object') return tiers
  const r = result as Record<string, unknown>
  for (const [key, name] of [
    ['AFPFiveHour', TIER_FIVE_HOUR],
    ['AFPWeekly', TIER_WEEKLY],
    ['AFPMonthly', TIER_MONTHLY],
  ] as const) {
    const win = r[key]
    if (!win || typeof win !== 'object') continue
    const w = win as Record<string, unknown>
    const quota = num(w.Quota) ?? 0
    if (quota <= 0) continue
    const used = num(w.Used) ?? 0
    const utilization = (used / quota) * 100
    tiers.push({
      name,
      label: WINDOW_LABELS[name],
      utilization,
      resets_at: epochToIso(w.ResetTime),
      used,
      quota,
    })
  }
  return tiers
}

const CODING_WINDOW_LABELS: Record<string, string> = {
  session: TIER_FIVE_HOUR,
  '5h': TIER_FIVE_HOUR,
  fivehour: TIER_FIVE_HOUR,
  five_hour: TIER_FIVE_HOUR,
  rolling_5h: TIER_FIVE_HOUR,
  weekly: TIER_WEEKLY,
  week: TIER_WEEKLY,
  '7d': TIER_WEEKLY,
  monthly: TIER_MONTHLY,
  month: TIER_MONTHLY,
}

/** Parse GetCodingPlanUsage Result → tiers. The API returns percentage-only
 *  windows; defensively match several field-name families. */
export function parseCodingPlanTiers(result: unknown): QuotaTier[] {
  const tiers: QuotaTier[] = []
  if (!result || typeof result !== 'object') return tiers
  const r = result as Record<string, unknown>
  const arr =
    (Array.isArray(r.QuotaUsage) && r.QuotaUsage) ||
    (Array.isArray(r.Usages) && r.Usages) ||
    (Array.isArray(r.Details) && r.Details)
  if (!arr) return tiers
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const labelRaw = it.Level ?? it.Type ?? it.Period ?? it.Label ?? it.Window
    if (typeof labelRaw !== 'string') continue
    const name = CODING_WINDOW_LABELS[labelRaw.toLowerCase()]
    if (!name) continue
    const utilization = num(it.Percent) ?? num(it.UsedPercent) ?? num(it.UsagePercent) ?? 0
    tiers.push({
      name,
      label: WINDOW_LABELS[name],
      utilization,
      resets_at: epochToIso(it.ResetTime ?? it.ResetTimestamp),
    })
  }
  return tiers
}

type VolcCall =
  | { ok: true; body: unknown }
  | { ok: false; kind: 'auth' | 'soft' | 'transient'; message: string }

const AKSK_HINT =
  'Check the AccessKey ID / Secret are correct and the account has Ark usage-query (OpenAPI) permission.'

async function callOpenApi(http: HttpClient, region: string, ak: string, sk: string, action: string): Promise<VolcCall> {
  const query = canonicalQuery(action, region)
  const url = `https://${OPENAPI_HOST}/?${query}`
  const { authorization, xDate, contentSha256 } = signV4(ak, sk, region, action, Buffer.alloc(0))

  let res: HttpResult
  try {
    res = await http.request({
      url,
      method: 'POST',
      headers: {
        'X-Date': xDate,
        'X-Content-Sha256': contentSha256,
        'Content-Type': CONTENT_TYPE,
        Authorization: authorization,
      },
      body: '',
      timeoutMs: 15_000,
    })
  } catch (err) {
    return { ok: false, kind: 'transient', message: `Network error: ${(err as Error).message}` }
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: 'auth', message: `Authentication failed (HTTP ${res.status}). ${AKSK_HINT}` }
  }

  let body: unknown
  try {
    body = JSON.parse(res.body)
  } catch {
    return { ok: false, kind: 'soft', message: `API error (HTTP ${res.status}): failed to parse response` }
  }

  // Volcengine returns business errors both as 4xx and as 200 + ResponseMetadata.Error.
  const err = responseError(body)
  if (err) {
    if (isAuthErrorCode(err.code)) {
      return {
        ok: false,
        kind: 'auth',
        message: `Authentication failed (HTTP ${res.status}, ${err.code}): ${err.message}. ${AKSK_HINT}`,
      }
    }
    return { ok: false, kind: 'soft', message: `API error (HTTP ${res.status}, ${err.code}): ${err.message}` }
  }

  if (!res.status.toString().startsWith('2')) {
    return { ok: false, kind: 'soft', message: `API error (HTTP ${res.status})` }
  }

  return { ok: true, body }
}

/** Query Agent Plan first (absolute AFP quota); if the account has no Agent
 *  Plan, fall back to Coding Plan (percentage windows). Both share the same
 *  AK/SK, so an auth failure aborts immediately. */
async function queryVolcengine(
  http: HttpClient,
  region: string,
  ak: string,
  sk: string,
): Promise<PlatformQueryResult> {
  const agent = await callOpenApi(http, region, ak, sk, 'GetAFPUsage')
  if (agent.ok) {
    const r = (agent.body as { Result?: unknown }).Result
    const tiers = parseAfpTiers(r)
    if (tiers.length > 0) {
      const planType =
        r && typeof r === 'object' && typeof (r as Record<string, unknown>).PlanType === 'string'
          ? ((r as Record<string, unknown>).PlanType as string)
          : null
      return { data: { planKind: 'agent', planType, tiers }, error: null }
    }
    // Authenticated but no Agent Plan → fall through to Coding Plan.
  } else if (agent.kind === 'auth' || agent.kind === 'transient') {
    return { data: null, error: { kind: agent.kind, message: agent.message } }
  }

  const coding = await callOpenApi(http, region, ak, sk, 'GetCodingPlanUsage')
  if (coding.ok) {
    const r = (coding.body as { Result?: unknown }).Result
    const tiers = parseCodingPlanTiers(r)
    return { data: { planKind: tiers.length > 0 ? 'coding' : null, planType: null, tiers }, error: null }
  }
  if (coding.kind === 'auth') {
    return { data: null, error: { kind: coding.kind, message: coding.message } }
  }
  return {
    data: null,
    error: { kind: 'soft', message: agent.ok ? coding.message : agent.message },
  }
}

export const volcengineAdapter: PlatformAdapter = {
  id: 'volcengine',
  label: 'Ark',
  isConfigured: (cfg) => Boolean(cfg.volcAccessKeyId && cfg.volcSecretAccessKey),
  query: (http, cfg) =>
    queryVolcengine(http, deriveRegion(cfg.volcBaseUrl), cfg.volcAccessKeyId, cfg.volcSecretAccessKey),
}