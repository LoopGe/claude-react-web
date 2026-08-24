// Account info surfaced from the SDK's Query.accountInfo() control request
// (the data behind the CLI's account line: who is logged in, which auth
// backend is active). Browser-safe, SDK-agnostic: the server narrows the
// raw SDK response through coerceAccountInfo before it goes over the wire,
// so the client renders a guaranteed-clean shape.

/** Mirrors the SDK's AccountInfo (all fields optional — a third-party /
 *  gateway session reports little beyond apiProvider). */
export interface AccountInfoData {
  email?: string
  organization?: string
  subscriptionType?: string
  /** Where the auth token came from ('oauth', 'apiKey', …) — first-party
   *  sessions only. */
  tokenSource?: string
  apiKeySource?: string
  /** Active API backend. First-party OAuth login only applies when
   *  'firstParty'; for the others the remaining fields are absent and auth
   *  is external (AWS creds, gcloud ADC, …). 'gateway' means the CLI is
   *  authenticated against an enterprise gateway. */
  apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'mantle' | 'gateway'
}

const API_PROVIDERS = new Set([
  'firstParty', 'bedrock', 'vertex', 'foundry', 'anthropicAws', 'mantle', 'gateway',
])

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/** Defensive narrowing of an unknown SDK response into AccountInfoData.
 *  Non-string / empty fields are dropped rather than passed through; an
 *  entirely malformed value collapses to undefined. */
export function coerceAccountInfo(v: unknown): AccountInfoData | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const r = v as Record<string, unknown>
  const out: AccountInfoData = {}
  for (const key of ['email', 'organization', 'subscriptionType', 'tokenSource', 'apiKeySource'] as const) {
    const s = str(r[key])
    if (s !== undefined) out[key] = s
  }
  if (typeof r.apiProvider === 'string' && API_PROVIDERS.has(r.apiProvider)) {
    out.apiProvider = r.apiProvider as AccountInfoData['apiProvider']
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Human labels for AccountInfoData.apiProvider (UI display). */
export const ACCOUNT_PROVIDER_LABELS: Record<NonNullable<AccountInfoData['apiProvider']>, string> = {
  firstParty: 'Anthropic (claude.ai login)',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
  anthropicAws: 'Claude on AWS',
  mantle: 'Mantle',
  gateway: 'Enterprise gateway',
}
