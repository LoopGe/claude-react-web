// Config-related routes: setup, defaults, full config, update.

import { Hono } from 'hono'
import { serverDefaultCwd } from '../default-cwd.js'
import { readFile } from 'node:fs/promises'
import { join as joinPath } from 'node:path'
import { claudeConfigDir } from '../claude-config-dir.js'
import { SessionManager } from '../session-manager.js'
import { HttpError } from '../errors.js'
import { createLogger } from '../log.js'
import { safeJson } from './index.js'

const log = createLogger('config')
import { config as serverConfig, DEFAULT_PROFILE, LEGACY_PROFILE_KEYS, queueConfigWrite, updateConfigFile, MAX_PASTED_IMAGE_BYTES } from '../config.js'
import {
  LOG_LEVELS, getLogConfig, setLogConfig, type LogLevel,
  enableFileLogging, disableFileLogging, isFileLoggingEnabled, getLogFilePath,
} from '../log.js'
import { coerceProfileEntries, maskToken, normalizeModelList, profileFromLegacyFields, resolveActiveProfile, type LegacyProfileFields } from '../profiles.js'

export function buildConfigRouter(sm: SessionManager, configDir?: string): Hono {
  const app = new Hono()

  // Config setup — write authToken/baseUrl/model fields to config.json and
  // hot-reload. Accepts optional modelList / recapModel / commitMessageModel
  // so the setup page can configure everything in one shot.
  app.post('/config/setup', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const body = await safeJson<{
      authToken?: string
      baseUrl?: string
      modelList?: string[]
      recapModel?: string
      commitMessageModel?: string
      updateCheckRegistry?: string
    }>(c.req)
    // An unreadable config.json is handled by readConfigForWrite inside
    // queueConfigWrite (server/config.ts), which backs the original up rather
    // than letting this write discard it. Deliberately NOT reimplemented here —
    // the queue covers every writer, and one definition cannot drift.
    //
    // The whole read-modify-write runs INSIDE the serialized config write queue
    // — the same queue every other config.json writer uses (updateConfigFile /
    // queueConfigWrite). Reading and writing this file by hand let a concurrent
    // writer (PUT /config, /profiles/*, clearCredentials, PUT /log) land in
    // between: ours clobbered its change, or its write clobbered ours and the
    // token was lost with the wizard left un-leavable. config.ts states the rule
    // — queueConfigWrite "MUST be used for any direct config.json edit". The
    // 400s thrown below propagate to the caller, and do not poison the queue.
    //
    // The queue reads through readConfigForWrite (server/config.ts): a missing file
    // arrives as {}, and a file that cannot be READ or parsed is copied aside
    // first, then arrives as {}. So the heal below always operates on a plain
    // object it can safely write over, and the original is never destroyed.
    await queueConfigWrite(configDir, (existing) => {
      // Heal a config the reader cannot resolve a profile out of BEFORE writing,
      // because every write below targets a profile entry. A `profiles` key that
      // is absent, empty, or holds no entry surviving coercion all make
      // applyParsedConfig fall back to its synthetic default — so the legacy
      // top-level keys this route used to write were never read back, and the
      // wizard reported success while staying unconfigured with no way out.
      // Materialize the profile the reader is ALREADY falling back to instead,
      // seeded from any pre-migration top-level credential.
      const rawActiveId = typeof existing.activeProfileId === 'string' ? existing.activeProfileId.trim() : ''
      let entries = coerceProfileEntries(existing.profiles, DEFAULT_PROFILE)
      if (entries.length === 0) {
        const seeded = profileFromLegacyFields(existing as unknown as LegacyProfileFields, DEFAULT_PROFILE)
        // PREPEND rather than replace. Entries that fail coercion are invisible to
        // the reader but may still hold a credential the user typed, so replacing
        // the array would destroy it silently. Prepending cannot shadow: an entry
        // only survives coercion with a non-blank id AND name, and any entry like
        // that would have made `entries` non-empty.
        const raw = Array.isArray(existing.profiles) ? (existing.profiles as unknown[]) : []
        existing.profiles = [seeded, ...raw]
        entries = coerceProfileEntries(existing.profiles, DEFAULT_PROFILE)
      }
      // Retire the legacy top-level keys UNCONDITIONALLY, not only when the seed
      // above absorbed them. applyParsedConfig no longer reads them, so any
      // survivor is a second, dead source of truth: GET /config/full prefers the
      // raw key when masking, and if `profiles` is later removed,
      // migrateLegacyProfiles would resurrect the stale value over the token just
      // saved. MUST run after the seed, which is what reads these fields.
      for (const key of LEGACY_PROFILE_KEYS) delete existing[key]

      // Write the setup fields into the profile the server actually READS — the
      // one `activeProfileId` names. applyParsedConfig derives the top-level
      // authToken/baseUrl/model* fields from that profile, so writing profiles[0]
      // addresses the WRONG profile whenever the active one is not first. That is
      // the normal case: `POST /profiles` appends and `POST /profiles/activate`
      // selects the appended profile. It made the wizard impossible to leave —
      // the token was saved, `configured` stayed false, and the next page load
      // returned the user to the wizard.
      //
      // Resolved through the same code path the read side uses, so the two cannot
      // drift apart again: coerceProfileEntries (which `coerceProfiles` is a
      // projection of) then resolveActiveProfile's
      // findProfile(activeProfileId) ?? profiles[0].
      const active = resolveActiveProfile(
        entries.map((entry) => entry.profile),
        rawActiveId || DEFAULT_PROFILE.id,
        DEFAULT_PROFILE,
      )
      // Point activeProfileId at what the reader actually resolved. A dangling id
      // survives loadConfig as-is (applyParsedConfig keeps the stale string while
      // falling back to profiles[0]), which leaves every profile reporting
      // `isActive: false` in Settings and defeats DELETE /profiles/:id's
      // "cannot delete the active profile" guard.
      if (existing.activeProfileId !== active.id) existing.activeProfileId = active.id
      // The RAW index the reader will consult. Identity comparison is exact:
      // `active` is either one of these entries or the synthetic fallback, never
      // a lookalike. Re-deriving the index by matching `id` by hand would disagree
      // with the coercion on trimmed ids and on duplicate ids (last one wins) —
      // which is exactly how this route came to write a profile nobody reads.
      const hit = entries.find((entry) => entry.profile === active)
      // Unreachable after the heal above, which guarantees an entry — but writing
      // an index the reader ignores is the bug this route exists to avoid, so fail
      // loudly rather than guess one.
      if (!hit) throw new HttpError(500, 'no resolvable provider profile after config heal')
      const profilesArr = existing.profiles as unknown[]
      const prof = { ...(profilesArr[hit.index] as Record<string, unknown>) }
      if (typeof body.authToken === 'string' && body.authToken.trim()) {
        prof.authToken = body.authToken.trim()
      } else if (!active.authToken) {
        // Test the COERCED token, not the raw one: coerceProfiles trims (and
        // string-checks) authToken, so a stored '   ' or 12345 is '' to the
        // reader. Checking the raw value would let that pass, keep an unusable
        // token, and answer 200 configured:false — reporting a profile-selection
        // problem where the real one is a blank token.
        throw new HttpError(400, 'authToken is required')
      }
      if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
        prof.baseUrl = body.baseUrl.trim().replace(/\/+$/, '')
      }
      // Only an explicitly-sent, usable list replaces the stored one — absent and
      // all-blank both mean "leave it alone". normalizeModelList filters before
      // deciding, so an all-blank list cannot persist `modelList: []` (which the
      // reader treats as absent and replaces with the hardcoded DEFAULTS ids,
      // unroutable on a third-party gateway).
      const nextModelList = normalizeModelList(body.modelList, [])
      if (nextModelList.length > 0) prof.modelList = nextModelList
      // Stored as '' rather than dropped: '' is the explicit "unset — use
      // the session's own model" value. (A deleted key would resurrect the
      // DEFAULTS value if that ever became a real model id again.)
      if (typeof body.recapModel === 'string') {
        prof.recapModel = body.recapModel.trim()
      }
      if (typeof body.commitMessageModel === 'string') {
        prof.commitMessageModel = body.commitMessageModel.trim()
      }
      profilesArr[hit.index] = prof
      if (typeof body.updateCheckRegistry === 'string') {
        // Persist verbatim (trimmed) — empty string is a valid value meaning
        // "update checks disabled", so we write it rather than dropping it.
        existing.updateCheckRegistry = body.updateCheckRegistry.trim()
      }
    })
    log.info('config/setup saved')
    return c.json({ ok: true, configured: !!serverConfig.authToken })
  })

  // Test connection — verify a token + baseUrl can reach the API, WITHOUT
  // depending on the user having configured a valid model yet (the natural
  // flow is token/URL first, model second) and WITHOUT spending tokens.
  //
  // The trick: POST /v1/messages with a deliberately-invalid sentinel model.
  // Auth happens before the body's model is validated, and the bogus model is
  // rejected before any inference runs — so this round-trips for free.
  //
  // Classification (auth vs. wrong-base-url vs. success) lives in the shared
  // `testConnection` helper (server/config-test-connection.ts). This route is
  // the API-level probe for callers that only hold a token + URL, so it always
  // uses the free sentinel probe — POST /profiles/:id/test (the Profile card's
  // button) passes the profile's own model instead, since a gateway rejects an
  // unroutable model with 401, which the sentinel probe cannot tell apart from
  // a bad token. Note the guard in front of both: an internal/LAN baseUrl is
  // refused by SSRF validation before any probe runs.
  app.post('/config/test-connection', async (c) => {
    const body = await safeJson<{ authToken?: string; baseUrl?: string }>(c.req)
    // A field that is PRESENT but not a string is a caller error — silently
    // treating it as absent would probe the SAVED credentials and answer
    // 200 {ok:true} for values that were never tested.
    if (body.authToken !== undefined && typeof body.authToken !== 'string') {
      throw new HttpError(400, 'authToken must be a string')
    }
    if (body.baseUrl !== undefined && typeof body.baseUrl !== 'string') {
      throw new HttpError(400, 'baseUrl must be a string')
    }
    const token = body.authToken?.trim() || serverConfig.authToken
    if (!token) throw new HttpError(400, 'No auth token to test — enter one or save your config first')
    const baseUrl = (body.baseUrl?.trim() || serverConfig.baseUrl).replace(/\/+$/, '')
    const { testConnection } = await import('../config-test-connection.js')
    const result = await testConnection(token, baseUrl)
    return c.json(result.body, result.status)
  })

  // Read defaults from <claude config dir>/settings.json so the setup page can
  // pre-fill the token, base URL, and model list fields. Resolved through
  // claudeConfigDir() so it follows $CLAUDE_CONFIG_DIR like the CLI does.
  app.get('/config/claude-defaults', async (c) => {
    const settingsPath = joinPath(claudeConfigDir(), 'settings.json')
    try {
      const raw = JSON.parse(await readFile(settingsPath, 'utf8'))
      const env = raw?.env ?? {}
      const key = typeof env.ANTHROPIC_API_KEY === 'string' ? env.ANTHROPIC_API_KEY : undefined

      // Claude Code stores concrete model ids under env.ANTHROPIC_DEFAULT_*_MODEL
      // and names the active one via the top-level `model` alias (opus/sonnet/
      // haiku). Surface those ids as the setup model list, ordered so the
      // alias name by `model` lands first (? becomes the session default).
      const aliasEnvVar: Record<string, unknown> = {
        opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL,
        sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      }
      const baseOrder = ['opus', 'sonnet', 'haiku']
      const topAlias = typeof raw.model === 'string' ? raw.model.toLowerCase() : undefined
      const order = topAlias && baseOrder.includes(topAlias)
        ? [topAlias, ...baseOrder.filter((a) => a !== topAlias)]
        : baseOrder
      const modelList = order
        .map((a) => aliasEnvVar[a])
        .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
        .map((m) => m.trim())

      return c.json({
        hasKey: !!key,
        keySuffix: key ? key.slice(-4) : undefined,
        baseUrl: typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : undefined,
        modelList: modelList.length > 0 ? modelList : undefined,
        // The setup page names this file in its "pre-filled from …" hint. Ship
        // the path we actually read so the hint stays true when the CLI's
        // config dir has been relocated with CLAUDE_CONFIG_DIR.
        settingsPath,
      })
    } catch {
      log.debug('claude-defaults: settings.json not found or unreadable')
      return c.json({})
    }
  })

  // Full config — returns every field the UI needs for the settings modal.
  app.get('/config/full', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    // Mask the LIVE token only — the one applyParsedConfig derived from the
    // active profile. A stale legacy top-level key can still sit in a
    // hand-edited file, and reporting ITS mask alongside `configured: false`
    // would advertise a credential the server is not using. Type-guarded: a
    // hand-edited `"authToken": 12345` used to reach `.slice` and 500 this route.
    const liveToken = typeof serverConfig.authToken === 'string' ? serverConfig.authToken.trim() : ''
    return c.json({
      configured: !!serverConfig.authToken,
      authTokenMasked: maskToken(liveToken || undefined),
      baseUrl: serverConfig.baseUrl,
      modelList: serverConfig.modelList as string[],
      modelGroups: serverConfig.modelGroups,
      recapModel: serverConfig.recapModel,
      commitMessageModel: serverConfig.commitMessageModel,
      profiles: serverConfig.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        authTokenMasked: maskToken(p.authToken),
        baseUrl: p.baseUrl,
        modelList: p.modelList,
        modelGroups: p.modelGroups,
        recapModel: p.recapModel,
        commitMessageModel: p.commitMessageModel,
        isActive: p.id === serverConfig.activeProfileId,
      })),
      activeProfileId: serverConfig.activeProfileId,
      maxUploadBytes: serverConfig.maxUploadBytes,
      maxPastedImageBytes: MAX_PASTED_IMAGE_BYTES,
      historyCap: serverConfig.historyCap,
      maxGroupPanels: serverConfig.maxGroupPanels,
      workingStuckMs: serverConfig.workingStuckMs,
      updateCheckRegistry: serverConfig.updateCheckRegistry,
      skillLoadMode: serverConfig.skillLoadMode,
      enabledSkills: serverConfig.enabledSkills,
      showPinnedUserMessage: serverConfig.showPinnedUserMessage,
      autoRecap: serverConfig.autoRecap,
      toolGroupCards: serverConfig.toolGroupCards,
      autoExpandRunningGroups: serverConfig.autoExpandRunningGroups,
      showMessageHeaders: serverConfig.showMessageHeaders,
      rowGap: serverConfig.rowGap,
      textSpacing: serverConfig.textSpacing,
      fontSize: serverConfig.fontSize,
      appToolsGit: serverConfig.appToolsGit,
      firstPartyTools: serverConfig.firstPartyTools,
      allowSensitivePathEdits: serverConfig.allowSensitivePathEdits,
      defaults: {
        // Same one authority as GET /api/config — this surface used to
        // hardcode its own process.cwd() and disagree with it.
        cwd: serverDefaultCwd(),
        model: serverConfig.defaultModel,
      },
    })
  })

  // 鈹€鈹€ Runtime log config 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // Applied to the in-memory logger immediately AND persisted to config.json
  // so the chosen level/scopes survive restarts. Boot-time precedence:
  // LOG_LEVEL / LOG_SCOPES env vars (per-launch override) > persisted
  // config.json value > built-in default ('info' / all scopes).
  app.get('/log', (c) => {
    return c.json({
      ...getLogConfig(),
      availableLevels: LOG_LEVELS,
    })
  })

  app.put('/log', async (c) => {
    const body = await safeJson<{ level?: string; scopes?: string[] | null }>(c.req)
    const update: { level?: LogLevel; scopes?: string[] | null } = {}
    if (body.level != null) {
      if (typeof body.level !== 'string' || !LOG_LEVELS.includes(body.level as LogLevel)) {
        throw new HttpError(400, `level must be one of: ${LOG_LEVELS.join(', ')}`)
      }
      update.level = body.level as LogLevel
    }
    if (body.scopes !== undefined) {
      if (body.scopes !== null && !Array.isArray(body.scopes)) {
        throw new HttpError(400, 'scopes must be an array of strings or null')
      }
      if (Array.isArray(body.scopes) && !body.scopes.every((s) => typeof s === 'string')) {
        throw new HttpError(400, 'scopes must contain only strings')
      }
      update.scopes = body.scopes
    }
    const next = setLogConfig(update)
    // Persist so the choice survives restarts. Mirror the in-memory keys
    // onto the config.json keys (logLevel / logScopes). Only write the
    // dimensions the caller actually touched.
    if (configDir && (update.level !== undefined || update.scopes !== undefined)) {
      const persist: Record<string, unknown> = {}
      if (update.level !== undefined) persist.logLevel = next.level
      if (update.scopes !== undefined) persist.logScopes = next.scopes
      await updateConfigFile(configDir, persist)
    }
    return c.json({ ...next, availableLevels: LOG_LEVELS })
  })

  // 鈹€鈹€ File logging toggle 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // Persisted in config.json so it survives restarts.

  app.get('/log/file', (c) => {
    return c.json({
      enabled: isFileLoggingEnabled(),
      path: getLogFilePath(),
    })
  })

  app.put('/log/file', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const body = await safeJson<{ enabled?: unknown }>(c.req)
    if (typeof body.enabled !== 'boolean') {
      throw new HttpError(400, 'enabled must be a boolean')
    }
    if (body.enabled) {
      enableFileLogging(configDir)
    } else {
      disableFileLogging()
    }
    // Persist to config.json
    await updateConfigFile(configDir, { logToFile: body.enabled })
    return c.json({ enabled: isFileLoggingEnabled(), path: getLogFilePath() })
  })

  // Update config — merges partial updates into config.json and hot-reloads.
  app.put('/config', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const body = await safeJson<Record<string, unknown>>(c.req)
    // Detect whether the global skill policy is changing BEFORE the write
    // so we can re-fan-out only when it actually mutates. Reading from the
    // frozen config singleton is cheap and avoids a second disk read.
    const skillKeysTouched = 'skillLoadMode' in body || 'enabledSkills' in body
    const prevMode = serverConfig.skillLoadMode
    const prevEnabled = serverConfig.enabledSkills.slice()
    await updateConfigFile(configDir, body)
    log.info(`config updated keys=${Object.keys(body).join(',')}`)
    if (skillKeysTouched) {
      const changed = serverConfig.skillLoadMode !== prevMode
        || serverConfig.enabledSkills.length !== prevEnabled.length
        || serverConfig.enabledSkills.some((name, i) => name !== prevEnabled[i])
      if (changed) {
        // Best-effort fan-out: failures are reported per-session in the
        // result and never block the config save (the file is already on
        // disk; the user can retry the per-session toggle from the panel).
        void sm.reapplyGlobalSkillsToInheritingSessions().catch((err) => {
          log.warn(`reapplyGlobalSkillsToInheritingSessions failed: ${(err as Error).message}`)
        })
      }
    }
    return c.json({ ok: true, configured: !!serverConfig.authToken })
  })

  return app
}
