// server/providers/native/hooks/http-executor.ts
// Runs a `type:'http'` hook: POST the event JSON to the hook URL and parse the
// response body as hook output (RS §6.3). The request accepts ALL statuses
// (ok = 200≤status<300), never follows a redirect (fetch redirect:'manual', the
// CLI axios maxRedirects:0), and is bounded by the 600s default timeout / the
// parent abort signal. Header `$VAR`/`${VAR}` interpolation is restricted to the
// hook's allowedEnvVars intersected with the managed list; the URL is gated by
// allowedUrls (undefined = allow all, [] = deny all, wildcard `*`). A non-2xx /
// network error / URL refusal is a non-blocking failure that onFailure:'block'
// rewrites to a block (RS §2.4); a timeout / abort is cancelled.
//
// Neutral core: imports only shared/* types, sibling hooks modules and the
// scoped logger; fetch is the Node global. No SDK / host frame vocabulary.
import { createLogger } from '../../../log.js'
import type { HttpHookConfig } from '../../../../shared/hooks.js'
import { parseHookOutput, applyOnFailure, type HookExecResult } from './output.js'
import type { HookExecContext } from './command-executor.js'

const log = createLogger('native-hooks')

/** RS §4.5: the http-hook default timeout (CLI `xf=600000`). */
const DEFAULT_TIMEOUT_MS = 600_000
// setTimeout's 32-bit ceiling (RS §4.5, CLI `tc=2147483647`).
const MAX_TIMEOUT_MS = 2_147_483_647

/** The execution context an http hook receives: the base command-exec context
 *  plus the two settings gates (RS §6.3). `allowedUrls` is the merged
 *  `allowedHttpHookUrls` (undefined = allow all, [] = deny all); `managedEnvVars`
 *  is the merged `httpHookAllowedEnvVars` intersected with the hook's own
 *  allowedEnvVars (undefined = no intersection filter). Both arrive from the
 *  settings-source seam; until it lands they are undefined (allow-all URLs,
 *  hook-list-only interpolation). */
export interface HttpHookExecContext extends HookExecContext {
  allowedUrls?: string[]
  managedEnvVars?: string[]
}

/** Wildcard URL-pattern match (RS §6.3, CLI `Pee`): a bare `*` matches anything;
 *  otherwise `*` stands for any run of characters and the rest is literal,
 *  anchored to the whole URL. (The CLI's matcher additionally parses the URL /
 *  pattern and handles IDN punycode and bare-host patterns; that machinery is
 *  beyond this task's wildcard contract and is not ported here.) */
function wildcardMatch(url: string, pattern: string): boolean {
  if (pattern === '*') return true
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(url)
}

/** The CLI `UTr` header interpolation: `${VAR}` / `$VAR` (uppercase names) are
 *  replaced with the env value ONLY when the name is in the effective allow-set
 *  (hook.allowedEnvVars ∩ managed list); an unlisted name becomes the empty
 *  string. The final value is stripped of CR/LF/NUL (CLI `BTr`, a header-
 *  injection guard). The env is the inherited process env plus ctx.env
 *  overrides, the same discipline as the command executor's hookEnv. */
const ENV_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g
function interpolateHeaders(hook: HttpHookConfig, ctx: HttpHookExecContext): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (!hook.headers) return headers
  const listed = hook.allowedEnvVars ?? []
  const effective = ctx.managedEnvVars !== undefined
    ? listed.filter((name) => ctx.managedEnvVars!.includes(name))
    : listed
  const allow = new Set(effective)
  const env: NodeJS.ProcessEnv = { ...process.env, ...ctx.env }
  for (const [name, value] of Object.entries(hook.headers)) {
    const interpolated = value.replace(ENV_VAR_PATTERN, (_match: string, braced?: string, bare?: string) => {
      const varName = braced ?? bare ?? ''
      if (!allow.has(varName)) {
        log.debug(`http hook header env var $${varName} not in allowedEnvVars; skipping interpolation`)
        return ''
      }
      return env[varName] ?? ''
    })
    // eslint-disable-next-line no-control-regex -- stripping CR/LF/NUL is the explicit purpose of this header-injection guard (CLI BTr).
    headers[name] = interpolated.replace(/[\r\n\x00]/g, '')
  }
  return headers
}

/** Run one http hook. Never throws: a URL refusal / network error / non-2xx is a
 *  non-blocking error result, a timeout / abort is cancelled, and onFailure:
 *  'block' rewrites either to a block (RS §2.4). A 2xx body is handed to the
 *  shared output contract (parseHookOutput). */
export async function runHttpHook(
  hook: HttpHookConfig,
  input: Record<string, unknown>,
  ctx: HttpHookExecContext,
): Promise<HookExecResult> {
  // URL gate (RS §6.3): undefined = allow all; otherwise the URL must match at
  // least one pattern ([] matches nothing → every URL refused). A refusal is a
  // start failure — the request is never sent.
  if (ctx.allowedUrls !== undefined && !ctx.allowedUrls.some((pattern) => wildcardMatch(hook.url, pattern))) {
    const message = `HTTP hook blocked: ${hook.url} does not match any pattern in allowedHttpHookUrls`
    log.debug(message)
    return applyOnFailure(hook, { outcome: 'error', stdout: '', stderr: message })
  }

  if (ctx.signal.aborted) {
    return applyOnFailure(hook, { outcome: 'cancelled', stdout: '', stderr: 'hook aborted' })
  }

  // RS §4.5: per-hook timeout (seconds) clamped to the 32-bit ceiling, else the
  // 600s http default. The CLI uses truthiness (`e.timeout ? ... : xf`).
  const timeoutMs = hook.timeout ? Math.min(hook.timeout * 1000, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS
  const headers = interpolateHeaders(hook, ctx)

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const onParentAbort = () => controller.abort()
  ctx.signal.addEventListener('abort', onParentAbort, { once: true })

  let status: number
  let body: string
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
      signal: controller.signal,
      // maxRedirects:0 — a 3xx is returned as-is (a non-2xx failure), never
      // followed. Node fetch surfaces the real redirect status under 'manual'.
      redirect: 'manual',
    })
    status = res.status
    body = await res.text()
  } catch (err) {
    if (timedOut) {
      log.debug(`http hook (${hook.url}) timed out after ${timeoutMs}ms`)
      return applyOnFailure(hook, { outcome: 'cancelled', stdout: '', stderr: `hook timed out after ${timeoutMs}ms` })
    }
    if (ctx.signal.aborted) {
      return applyOnFailure(hook, { outcome: 'cancelled', stdout: '', stderr: 'hook aborted' })
    }
    const message = err instanceof Error ? err.message : String(err)
    log.debug(`http hook request failed: ${message}`)
    return applyOnFailure(hook, { outcome: 'error', stdout: '', stderr: message })
  } finally {
    clearTimeout(timer)
    ctx.signal.removeEventListener('abort', onParentAbort)
  }

  // A request that settles cleanly on abort is still a cancellation.
  if (timedOut) {
    return applyOnFailure(hook, { outcome: 'cancelled', stdout: '', stderr: `hook timed out after ${timeoutMs}ms` })
  }
  if (ctx.signal.aborted) {
    return applyOnFailure(hook, { outcome: 'cancelled', stdout: '', stderr: 'hook aborted' })
  }

  // Non-2xx: a non-blocking failure naming the status; the body is NOT parsed
  // (CLI consumer returns before the JSON parse on `error || !ok`).
  const ok = status >= 200 && status < 300
  if (!ok) {
    const message = `HTTP ${status} from ${hook.url}`
    log.debug(`http hook non-2xx: ${message}`)
    return applyOnFailure(hook, { outcome: 'error', exitCode: status, stdout: '', stderr: message })
  }

  // 2xx: parse the body as hook output. The CLI's http parser (`HYn`) refuses a
  // non-JSON body ("HTTP hook must return JSON") rather than treating it as
  // plain text the way command stdout is; an empty body is a no-op `{}` success
  // (parseHookOutput of '' yields a plain success with no decision, equivalent).
  const trimmed = body.trim()
  if (trimmed !== '' && !trimmed.startsWith('{')) {
    const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
    const message = `HTTP hook must return JSON, but got non-JSON response body: ${preview}`
    log.debug(message)
    return applyOnFailure(hook, { outcome: 'error', exitCode: status, stdout: body, stderr: message })
  }
  return applyOnFailure(hook, parseHookOutput(body, '', 0, hook))
}
