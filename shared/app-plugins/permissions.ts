// App Plugin permission model.
//
// IMPORTANT — trust model (see plan):
// A background plugin runs in a Node subprocess, which is a TRUSTED LOCAL
// PROGRAM. It can `import node:fs` and bypass any Host API. Therefore the
// permission system here is **consent UX + Host API feature flags + audit**,
// NOT a security sandbox. The real, enforced boundaries are:
//   - the iframe UI (CSP / no same-origin) — out of scope for v1
//   - the Host API network domain allowlist (a plugin that has not been
//     granted network.fetch for host X gets a typed error from the broker)
//   - not passing authToken/accessToken/baseUrl into the subprocess env
// Per-call checks stay (they're cheap, they make consent real for the
// domain-scoped capabilities, and they emit audit lines), but they must not
// be advertised as "preventing a malicious plugin from reading the disk".

// ── Permission catalog (collapsed) ───────────────────────────────────
//
// Relative to the original v1 plan, redundant tiers were merged: storage is
// one permission with a scope parameter (not three), sessions.read folds
// readMetadata+readMessages, and git.destructive was dropped (a trusted
// program can shell out, so a separate "destructive" tier is theatre).

export type AppPluginPermission =
  | 'storage'
  | 'network.fetch'
  | 'ai.request'
  | 'sessions.read'
  | 'sessions.send'
  | 'sessions.interrupt'
  | 'sessions.compact'
  | 'messages.selectedText'
  | 'git.read'
  | 'git.write'
  | 'workspace.read'
  | 'workspace.write'
  | 'secrets.read'
  | 'secrets.write'
  | 'ui.notifications'
  | 'ui.popovers'
  | 'ui.dialogs'
  | 'ui.clipboard'
  | 'ui.openExternal'
  | 'process.execute'

export const ALL_PERMISSIONS: readonly AppPluginPermission[] = [
  'storage',
  'network.fetch',
  'ai.request',
  'sessions.read',
  'sessions.send',
  'sessions.interrupt',
  'sessions.compact',
  'messages.selectedText',
  'git.read',
  'git.write',
  'workspace.read',
  'workspace.write',
  'secrets.read',
  'secrets.write',
  'ui.notifications',
  'ui.popovers',
  'ui.dialogs',
  'ui.clipboard',
  'ui.openExternal',
  'process.execute',
]

const PERMISSION_SET = new Set<string>(ALL_PERMISSIONS)

/** Per-permission parameters that broaden what the capability grants. Only
 *  `network.fetch` carries parameters in v1 (the declared host allowlist +
 *  purpose). A broader allowlist on update is a permission escalation. */
export interface PermissionParams {
  /** For `network.fetch`: the declared hosts the plugin may call. Each is a
   *  bare host (`api.example.com`) — scheme and port are enforced by the
   *  broker (HTTPS only, default ports). Wildcards allowed as a leading
   *  `*.` suffix segment (`*.example.com`). */
  hosts?: string[]
  /** Free-text purpose, shown in the consent UI. Not enforced. */
  purpose?: string
}

export type PermissionSpec = AppPluginPermission | { permission: AppPluginPermission; params?: PermissionParams }

/** Normalised form stored in the registry and compared on update. A bare
 *  string permission is equivalent to `{ permission, params: {} }`. */
export interface NormalisedPermission {
  permission: AppPluginPermission
  params: PermissionParams
}

export function isKnownPermission(p: string): p is AppPluginPermission {
  return PERMISSION_SET.has(p)
}

/** Normalise a manifest permission declaration into a stable comparable
 *  form. Unknown permissions are dropped (with a caller-visible diagnostic
 *  list) — they never silently enable a capability. */
export function normalisePermissions(specs: PermissionSpec[]): {
  permissions: NormalisedPermission[]
  unknown: string[]
} {
  const out: NormalisedPermission[] = []
  const unknown: string[] = []
  const seen = new Set<string>()
  for (const spec of specs) {
    const perm = typeof spec === 'string' ? spec : spec.permission
    if (!isKnownPermission(perm)) {
      unknown.push(perm)
      continue
    }
    const params = typeof spec === 'string' ? {} : spec.params ?? {}
    const key = permissionKey(perm, params)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ permission: perm, params: normaliseParams(perm, params) })
  }
  return { permissions: out, unknown }
}

function normaliseParams(perm: AppPluginPermission, params: PermissionParams): PermissionParams {
  if (perm !== 'network.fetch') return {}
  const hosts = (params.hosts ?? [])
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0)
    .filter((h) => isValidHost(h))
  const sorted = Array.from(new Set(hosts)).sort()
  return sorted.length > 0 ? { hosts: sorted, purpose: params.purpose?.trim() || undefined } : {}
}

/** A declared network host: lowercase, optional leading `*.`, otherwise a
 *  valid hostname (letters/digits/-/.). Rejects IPs (use a host name), ports,
 *  schemes, wildcards anywhere but the leading label.
 *
 *  Also rejects integer / hex / octal IP-literal forms (`2130706433`,
 *  `0x7f000001`, `017700000001`) — these are valid to a socket but resolve to
 *  localhost / private ranges, defeating the SSRF allowlist if a plugin
 *  declared them as "hosts". Bare-decimal labels (`123`) are rejected too. */
export function isValidHost(h: string): boolean {
  if (!h || h.length > 253) return false
  if (h.startsWith('*.')) {
    const rest = h.slice(2)
    return rest.length > 0 && isValidHost(rest) && !rest.includes('*')
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false // dotted-quad IPv4
  if (h.includes(':')) return false // no ports / IPv6
  // Reject integer / hex / octal IP literals and any all-digit label.
  if (/^\d+$/.test(h)) return false
  if (/^0[xX][0-9a-fA-F]+$/.test(h)) return false
  if (/^0[0-7]+$/.test(h)) return false
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h)
}

function permissionKey(perm: AppPluginPermission, params: PermissionParams): string {
  if (perm !== 'network.fetch') return perm
  return `${perm}|${(params.hosts ?? []).join(',')}`
}

// ── Permission diff (update-time escalation gate) ────────────────────

export interface PermissionDiff {
  added: NormalisedPermission[]
  removed: NormalisedPermission[]
  /** Existing permissions whose params broadened (e.g. network.fetch host
   *  set grew). Treated as an escalation — requires re-consent. */
  broadened: NormalisedPermission[]
  isEscalation: boolean
}

/** Compare a previously-granted set against a newly-declared set. Any `added`
 *  or `broadened` entry makes `isEscalation` true → the new version enters
 *  `permission-required` and must not auto-enable. */
export function diffPermissions(
  granted: NormalisedPermission[],
  declared: NormalisedPermission[],
): PermissionDiff {
  const gMap = new Map(granted.map((p) => [p.permission, p]))
  const dMap = new Map(declared.map((p) => [p.permission, p]))
  const added: NormalisedPermission[] = []
  const removed: NormalisedPermission[] = []
  const broadened: NormalisedPermission[] = []

  for (const [perm, d] of dMap) {
    const g = gMap.get(perm)
    if (!g) {
      added.push(d)
      continue
    }
    if (perm === 'network.fetch') {
      const gHosts = new Set(g.params.hosts ?? [])
      const dHosts = d.params.hosts ?? []
      const grew = dHosts.some((h) => !gHosts.has(h))
      if (grew) broadened.push(d)
    }
  }
  for (const [perm, g] of gMap) {
    if (!dMap.has(perm)) removed.push(g)
  }
  return { added, removed, broadened, isEscalation: added.length > 0 || broadened.length > 0 }
}

/** Does `granted` authorise `need` for this call? For network.fetch, the
 *  call's target host must be covered by the granted host allowlist
 *  (exact or `*.suffix`). Other permissions are a simple set membership. */
export function hasPermission(
  granted: NormalisedPermission[],
  need: AppPluginPermission,
  callParams?: { host?: string },
): boolean {
  const g = granted.find((p) => p.permission === need)
  if (!g) return false
  if (need !== 'network.fetch') return true
  const host = callParams?.host?.toLowerCase()
  if (!host) return false
  const hosts = g.params.hosts ?? []
  return hosts.some((h) => hostMatches(host, h))
}

/** True iff `host` is covered by a declared `pattern` (exact or leading
 *  `*.`). `pattern` must already be lowercase. */
export function hostMatches(host: string, pattern: string): boolean {
  if (host === pattern) return true
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1) // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length
  }
  return false
}
