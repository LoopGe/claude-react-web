// Regression tests for the P0 defect: `POST /config/setup` wrote `profiles[0]`
// unconditionally, while the app READS the profile named by `activeProfileId`.
//
//   READ:  applyParsedConfig derives authToken/baseUrl/modelList/modelGroups/
//          recapModel/commitMessageModel from the ACTIVE profile
//          (server/config.ts:504-518).
//   GATE:  `configured` == `!!config.authToken` (server/app.ts:244); App.tsx
//          renders SetupPage while it is falsy.
//
// Because `POST /profiles` APPENDS and `POST /profiles/activate` selects the
// appended profile, the active profile is routinely NOT at index 0. Combined
// with `clearCredentials()` (the About tab's "Clear configuration & data →
// credentials"), which blanks every profile's token while preserving array
// order, that produced a wizard the user could never leave: the token was
// saved, `configured` stayed false, and the next page load returned them here.
//
// These tests pin the contract that write and read target the SAME profile.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { buildConfigRouter } from './config-routes.js'
import { createErrorHandler } from '../errors.js'
import { clearCredentials, config, loadConfig } from '../config.js'
import { rmRf, tempDir } from '../__test-utils__/index.js'
import type { SessionManager } from '../session-manager.js'

function profile(id: string, name: string, authToken: string) {
  return {
    id, name, authToken,
    baseUrl: 'https://api.anthropic.com',
    modelList: ['anthropic/claude-sonnet-4-20250514'],
    modelGroups: [],
    recapModel: '',
    commitMessageModel: '',
  }
}

/** Two profiles with the SECOND one active — the shape `POST /profiles` +
 *  `POST /profiles/activate` produces (creation appends, so a newly created
 *  and then activated profile is never at index 0). */
function twoProfiles(activeIsSecond: boolean) {
  return {
    profiles: [profile('default', 'Default', 'sk-first'), profile('p_two', 'Second', 'sk-second')],
    activeProfileId: activeIsSecond ? 'p_two' : 'default',
  }
}

function setup(sm: SessionManager, dir: string, body: Record<string, unknown>) {
  // Compose the router the way server/routes/index.ts does: an HttpError thrown
  // by the handler is translated into a JSON status by the composition's
  // onError, not by the sub-router itself — calling buildConfigRouter bare would
  // surface a 400 as an opaque 500.
  const app = new Hono()
  app.onError(createErrorHandler('[test]'))
  app.route('/', buildConfigRouter(sm, dir))
  return app.request('/config/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const readConfig = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
    baseUrl?: string
    authToken?: string
    activeProfileId?: string
    profiles: { id: string; authToken: string; baseUrl?: string; modelList?: string[] }[]
  }

const sm = {} as unknown as SessionManager

describe('POST /config/setup targets the profile the app reads', () => {
  it('the gate reads the ACTIVE profile, not profiles[0]', async () => {
    // Control for the READ side: blanking ONLY profiles[0] must leave us
    // configured, proving the gate does not consult profiles[0].
    const dir = tempDir('setup-active-read')
    try {
      const cfg = twoProfiles(true)
      cfg.profiles[0].authToken = ''
      writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg))
      await loadConfig(dir)
      expect(config.authToken).toBe('sk-second')
    } finally {
      rmRf(dir)
    }
  })

  it('is reachable from the wizard: clearCredentials leaves the active profile at index 1', async () => {
    // The precondition the fix has to survive. `clearCredentials` blanks every
    // profile but keeps array order and activeProfileId, so the wizard is shown
    // while the active profile sits at index 1.
    const dir = tempDir('setup-clear')
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify(twoProfiles(true)))
      await loadConfig(dir)
      expect(config.authToken).toBe('sk-second')

      await clearCredentials(dir)

      const written = readConfig(dir)
      expect(written.profiles.map((p) => p.authToken)).toEqual(['', ''])
      expect(written.profiles.map((p) => p.id)).toEqual(['default', 'p_two'])
      expect(written.activeProfileId).toBe('p_two')
      expect(config.authToken).toBeUndefined() // SetupPage is shown here
    } finally {
      rmRf(dir)
    }
  })

  it('writes the token to the ACTIVE profile, leaving profiles[0] alone', async () => {
    // The regression. Before the fix this wrote profiles[0] ('default') and
    // returned `configured: false`, trapping the user in the wizard.
    const dir = tempDir('setup-active-write')
    try {
      const cfg = twoProfiles(true)
      cfg.profiles[0].authToken = ''
      cfg.profiles[1].authToken = ''
      writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg))
      await loadConfig(dir)
      expect(config.authToken).toBeUndefined()

      const res = await setup(sm, dir, { authToken: 'sk-brand-new' })
      expect(res.status).toBe(200)

      const written = readConfig(dir)
      expect(written.profiles[1].authToken).toBe('sk-brand-new')
      expect(written.profiles[0].authToken).toBe('')
      expect(written.activeProfileId).toBe('p_two')

      // The gate now reports configured, so the client may leave the wizard —
      // and `GET /config` agrees, so a reload does not bounce back.
      expect(await res.json()).toMatchObject({ ok: true, configured: true })
      expect(config.authToken).toBe('sk-brand-new')
    } finally {
      rmRf(dir)
    }
  })

  it('still targets profiles[0] when the active profile IS profiles[0]', async () => {
    // The ordinary single/first-profile case must be unchanged.
    const dir = tempDir('setup-first-write')
    try {
      const cfg = twoProfiles(false)
      cfg.profiles[0].authToken = ''
      cfg.profiles[1].authToken = ''
      writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg))
      await loadConfig(dir)

      const res = await setup(sm, dir, { authToken: 'sk-brand-new' })
      expect(res.status).toBe(200)

      const written = readConfig(dir)
      expect(written.profiles[0].authToken).toBe('sk-brand-new')
      expect(written.profiles[1].authToken).toBe('')
      expect(await res.json()).toMatchObject({ ok: true, configured: true })
    } finally {
      rmRf(dir)
    }
  })

  it('falls back to profiles[0] when activeProfileId is dangling', async () => {
    // Mirrors resolveActiveProfile's `findProfile(id) ?? profiles[0]`, so a
    // stale activeProfileId cannot desync the write from the read.
    const dir = tempDir('setup-dangling')
    try {
      const cfg = twoProfiles(false)
      cfg.profiles[0].authToken = ''
      cfg.profiles[1].authToken = ''
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...cfg, activeProfileId: 'nope' }))
      await loadConfig(dir)

      const res = await setup(sm, dir, { authToken: 'sk-brand-new' })
      expect(res.status).toBe(200)

      const written = readConfig(dir)
      expect(written.profiles[0].authToken).toBe('sk-brand-new')
      expect(await res.json()).toMatchObject({ configured: true })
    } finally {
      rmRf(dir)
    }
  })

  it('400s when the ACTIVE profile has no token and none is submitted', async () => {
    // The `authToken is required` guard has to examine the profile being
    // written. It used to check profiles[0], so with profiles[0] holding a
    // token and the ACTIVE profile blank it passed and returned ok:true while
    // writing nothing the app would read.
    const dir = tempDir('setup-required')
    try {
      const cfg = twoProfiles(true)
      cfg.profiles[1].authToken = '' // active profile has no token
      writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg))
      await loadConfig(dir)

      const res = await setup(sm, dir, {})
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: expect.stringMatching(/authToken is required/) })
      // profiles[0]'s token must not be mistaken for the active profile's.
      expect(readConfig(dir).profiles[0].authToken).toBe('sk-first')
    } finally {
      rmRf(dir)
    }
  })

  it('400s when the ACTIVE profile stores a whitespace-only token the reader discards', async () => {
    // The guard has to read the COERCED token: coerceProfiles trims (and
    // string-checks) authToken, so a stored '   ' is '' to the reader. Testing
    // the raw value would let it pass, keep an unusable token and answer 200
    // configured:false — blaming profile selection for what is a blank token.
    const dir = tempDir('setup-blank-token')
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        profiles: [
          profile('default', 'Default', ''),
          { ...profile('p_two', 'Second', ''), authToken: '   ' },
        ],
        activeProfileId: 'p_two',
      }))
      await loadConfig(dir)
      expect(config.authToken).toBeUndefined()

      const res = await setup(sm, dir, {})
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: expect.stringMatching(/authToken is required/) })
      // The unusable stored value is left alone — no partial write.
      expect(readConfig(dir).profiles[1].authToken).toBe('   ')
    } finally {
      rmRf(dir)
    }
  })

  it('targets the same duplicate-id entry the reader resolves (last one wins)', async () => {
    // coerceProfileEntries/coerceProfiles dedupe by id keeping the LAST entry,
    // so the reader's authToken comes from index 1. A hand-rolled
    // `findIndex(p => p.id === activeId)` would hit index 0 and save the token
    // to a profile the reader ignores — the original defect, in a new guise.
    const dir = tempDir('setup-dup-id')
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        profiles: [profile('default', 'First', ''), profile('default', 'Second', 'sk-second')],
        activeProfileId: 'default',
      }))
      await loadConfig(dir)
      expect(config.authToken).toBe('sk-second') // the reader used index 1

      const res = await setup(sm, dir, { authToken: 'sk-brand-new' })
      expect(res.status).toBe(200)

      const written = readConfig(dir)
      expect(written.profiles[1].authToken).toBe('sk-brand-new')
      expect(written.profiles[0].authToken).toBe('')
      expect(await res.json()).toMatchObject({ ok: true, configured: true })
    } finally {
      rmRf(dir)
    }
  })

  it('targets a padded raw id that the reader trims and resolves', async () => {
    // applyParsedConfig trims the id, so the reader DOES resolve this entry; a
    // hand-rolled id comparison on the untrimmed value would miss it and fall
    // back to profiles[0], writing a profile nobody reads.
    const dir = tempDir('setup-padded-id')
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        profiles: [
          profile('default', 'Default', ''),
          { ...profile('p_two', 'Second', ''), id: ' p_two ' },
        ],
        activeProfileId: 'p_two',
      }))
      await loadConfig(dir)

      const res = await setup(sm, dir, { authToken: 'sk-brand-new' })
      expect(res.status).toBe(200)

      const written = readConfig(dir)
      expect(written.profiles[1].authToken).toBe('sk-brand-new')
      expect(written.profiles[0].authToken).toBe('')
      expect(await res.json()).toMatchObject({ ok: true, configured: true })
    } finally {
      rmRf(dir)
    }
  })

  it('backs up an unparseable config.json and heals it instead of blocking the wizard', async () => {
    // Blocking the save would trap the user: SetupPage renders INSTEAD of the app
    // shell while the server is unconfigured, so Settings — and the About tab's
    // "clear configuration" — are unreachable from there. Silently overwriting
    // would destroy the file. So: copy it aside, then carry on.
    const dir = tempDir('setup-unparseable')
    try {
      const broken = '{ "profiles": [ }'
      writeFileSync(join(dir, 'config.json'), broken)

      const res = await setup(sm, dir, { authToken: 'sk-brand-new' })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, configured: true })

      // The original is recoverable, byte for byte, next to the healed file.
      const backups = readdirSync(dir).filter((f) => f.startsWith('config.json.unreadable-'))
      expect(backups).toHaveLength(1)
      expect(readFileSync(join(dir, backups[0]), 'utf8')).toBe(broken)

      expect(readConfig(dir).profiles[0].authToken).toBe('sk-brand-new')
    } finally {
      rmRf(dir)
    }
  })

  it('backs up valid JSON that is not an object, too', async () => {
    // readConfigFile collapses these to {} exactly like an unparseable file, so
    // they take the same backup-and-heal path.
    for (const body of ['[1,2,3]', 'null', '"hello"']) {
      const dir = tempDir('setup-non-object')
      try {
        writeFileSync(join(dir, 'config.json'), body)

        const res = await setup(sm, dir, { authToken: 'sk-brand-new' })
        expect(res.status).toBe(200)

        const backups = readdirSync(dir).filter((f) => f.startsWith('config.json.unreadable-'))
        expect(backups).toHaveLength(1)
        expect(readFileSync(join(dir, backups[0]), 'utf8')).toBe(body)
        expect(readConfig(dir).profiles[0].authToken).toBe('sk-brand-new')
      } finally {
        rmRf(dir)
      }
    }
  })

  it('400s on a non-object body instead of throwing a TypeError', async () => {
    // safeJson guarantees parseable JSON, not an object — a literal `null` body
    // used to reach `body.authToken` and answer an opaque 500.
    const dir = tempDir('setup-null-body')
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify(twoProfiles(false)))
      await loadConfig(dir)

      const res = await setup(sm, dir, null as unknown as Record<string, unknown>)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: expect.stringMatching(/must be a JSON object/) })
    } finally {
      rmRf(dir)
    }
  })

  it('accepts a body with no token when the ACTIVE profile already has one', async () => {
    // The wizard omits authToken when it was pre-filled from the CLI's
    // settings.json and the user did not retype it. That must stay valid.
    const dir = tempDir('setup-prefilled')
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify(twoProfiles(true)))
      await loadConfig(dir)

      const res = await setup(sm, dir, { modelList: ['anthropic/claude-sonnet-4-20250514'] })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, configured: true })

      const written = readConfig(dir)
      expect(written.profiles[1].authToken).toBe('sk-second') // untouched
      expect(written.profiles[1].modelList).toEqual(['anthropic/claude-sonnet-4-20250514'])
    } finally {
      rmRf(dir)
    }
  })
})

describe('POST /config/setup — heals a config with no resolvable profile', () => {
  // A `profiles` key that is absent, empty, or holds no entry surviving
  // coercion all make applyParsedConfig fall back to its synthetic default. The
  // route used to answer that with legacy top-level writes, which the reader
  // never reads back — so the wizard reported success while staying
  // unconfigured, and since SetupPage is rendered INSTEAD of the app shell
  // (Settings included) there was no way out of it. It now materializes the
  // profile the reader is already falling back to.

  it('materializes a profile for an empty profiles[] instead of writing a dead key', async () => {
    // Reachable via `PUT /config { profiles: [] }` — doUpdateConfigFile only
    // drops null/'' (server/config.ts:807-825) — and NOT via the UI, whose
    // PUT /config payload never carries `profiles` and whose profile deletion
    // refuses to remove the last one.
    const dir = tempDir('setup-empty-profiles')
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ profiles: [], activeProfileId: 'default' }))
      await loadConfig(dir)
      expect(config.authToken).toBeUndefined() // the wizard is shown

      const res = await setup(sm, dir, { authToken: 'sk-brand-new' })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, configured: true })

      const written = readConfig(dir)
      expect(written.profiles).toHaveLength(1)
      expect(written.profiles[0].id).toBe('default')
      expect(written.profiles[0].authToken).toBe('sk-brand-new')
      expect(written.activeProfileId).toBe('default')
      // No dead top-level key left behind.
      expect(written.authToken).toBeUndefined()
      expect(config.authToken).toBe('sk-brand-new')
    } finally {
      rmRf(dir)
    }
  })

  it('materializes a profile without discarding entries that failed coercion', async () => {
    // Coercion drops an entry with a blank name, so the reader ignores it — but
    // it can still hold a credential the user typed. The heal must therefore not
    // replace the array wholesale and destroy it silently.
    const dir = tempDir('setup-no-valid-profile')
    try {
      const orphan = { id: 'work', authToken: 'sk-real', baseUrl: 'https://gw.example.com' }
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        profiles: [{ garbage: true }, orphan],
        activeProfileId: 'default',
      }))
      await loadConfig(dir)
      expect(config.authToken).toBeUndefined()

      const res = await setup(sm, dir, { authToken: 'sk-brand-new' })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, configured: true })

      const written = readConfig(dir)
      expect(written.profiles[0].authToken).toBe('sk-brand-new')
      // The unusable entries survive the heal untouched.
      expect(written.profiles.slice(1)).toEqual([{ garbage: true }, orphan])
    } finally {
      rmRf(dir)
    }
  })

  it('repoints a dangling activeProfileId at the profile the reader resolves', async () => {
    // applyParsedConfig falls back to profiles[0] while keeping the stale id, so
    // every profile would report isActive:false in Settings and DELETE
    // /profiles/:id's "cannot delete the active profile" guard would miss the
    // profile actually in use.
    const dir = tempDir('setup-dangling-active')
    try {
      const cfg = twoProfiles(false)
      cfg.profiles[0].authToken = ''
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...cfg, activeProfileId: 'ghost' }))
      await loadConfig(dir)
      expect(config.authToken).toBeUndefined()

      const res = await setup(sm, dir, { authToken: 'sk-brand-new' })
      expect(res.status).toBe(200)
      expect(readConfig(dir).activeProfileId).toBe('default')
    } finally {
      rmRf(dir)
    }
  })

  it('seeds the materialized profile from a pre-migration top-level credential, then retires it', async () => {
    // A config.json written before `profiles` existed and never loaded (so
    // migrateLegacyProfiles has not folded it yet). Deliberately does NOT call
    // loadConfig first: loading would trigger that migration and the seed path
    // would no longer be exercised. The route reads the file itself, so this is
    // the state it actually sees.
    const dir = tempDir('setup-legacy-seed')
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        authToken: 'sk-legacy',
        baseUrl: 'https://gw.example.com/',
      }))

      // No token in the body: the seeded profile already carries one, so this
      // must NOT 400.
      const res = await setup(sm, dir, {})
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, configured: true })

      const written = readConfig(dir)
      expect(written.profiles[0].authToken).toBe('sk-legacy')
      expect(written.profiles[0].baseUrl).toBe('https://gw.example.com') // trailing / trimmed
      expect(written.activeProfileId).toBe('default')
      // The absorbed top-level keys are retired, so a later empty `profiles`
      // cannot resurrect them.
      expect(written.authToken).toBeUndefined()
      expect(written.baseUrl).toBeUndefined()
    } finally {
      rmRf(dir)
    }
  })
})

describe('POST /config/setup — write hygiene', () => {
  it('retires a stale legacy top-level key even when the profile already resolves', async () => {
    // Left behind, it is a second source of truth: /config/full prefers the raw
    // key when masking, and removing `profiles` later would let
    // migrateLegacyProfiles resurrect it over the token the wizard just saved.
    const dir = tempDir('setup-stale-legacy')
    try {
      const cfg = twoProfiles(false)
      cfg.profiles[0].authToken = ''
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        ...cfg,
        authToken: 'sk-stale-legacy', // dead: applyParsedConfig ignores it
      }))
      await loadConfig(dir)
      expect(config.authToken).toBeUndefined()

      const res = await setup(sm, dir, { authToken: 'sk-brand-new' })
      expect(res.status).toBe(200)

      const written = readConfig(dir)
      expect(written.profiles[0].authToken).toBe('sk-brand-new')
      expect(written.authToken).toBeUndefined()
      expect(config.authToken).toBe('sk-brand-new')
    } finally {
      rmRf(dir)
    }
  })

  it('ignores an all-blank modelList instead of persisting an empty one', async () => {
    // A stored `modelList: []` reads back as absent, so the profile would
    // silently fall back to the hardcoded DEFAULTS ids — unroutable on a
    // third-party gateway. PUT /profiles/:id 400s on an empty list for exactly
    // this reason, so this route must not be the one writer able to store it.
    const dir = tempDir('setup-blank-models')
    try {
      const cfg = twoProfiles(false)
      cfg.profiles[0].authToken = ''
      writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg))
      await loadConfig(dir)

      const res = await setup(sm, dir, { authToken: 'sk-brand-new', modelList: ['', '   '] })
      expect(res.status).toBe(200)

      expect(readConfig(dir).profiles[0].modelList).toEqual(['anthropic/claude-sonnet-4-20250514'])
      expect(config.modelList).toEqual(['anthropic/claude-sonnet-4-20250514'])
    } finally {
      rmRf(dir)
    }
  })

  it('does not seed an empty modelList from an all-blank legacy list', async () => {
    // Same trap as above, but reached through the heal's seed: [''] has length
    // > 0 yet yields no usable id, so storing `modelList: []` would read back as
    // absent and the profile would silently fall back to the hardcoded DEFAULTS
    // ids — unroutable on a third-party gateway.
    const dir = tempDir('setup-blank-legacy-models')
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        authToken: 'sk-legacy',
        modelList: ['', '   '],
      }))

      const res = await setup(sm, dir, {})
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, configured: true })

      // The whole DEFAULT_PROFILE list, not the all-blank legacy value and not
      // an empty one.
      const defaults = [
        'anthropic/claude-sonnet-4-20250514',
        'claude-opus-4-20250514',
        'claude-haiku-3-5-20241022',
      ]
      expect(readConfig(dir).profiles[0].modelList).toEqual(defaults)
      expect(config.modelList).toEqual(defaults)
    } finally {
      rmRf(dir)
    }
  })
})