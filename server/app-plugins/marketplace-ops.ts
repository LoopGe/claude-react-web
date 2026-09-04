import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AppPluginMarketplaceStore } from './marketplace-store.js'
import type { AppPluginMarketplaceRecord } from '../../shared/app-plugins/marketplace.js'
import { parseAppPluginMarketplaceAuto } from './marketplace-parser.js'
import { validateRelativePath } from '../../shared/app-plugins/path-security.js'
import { assertHttpsUrl, gitClone, gitGetHeadSha } from '../git-clone.js'
import { HttpError } from '../errors.js'

/** Clone an App Plugin marketplace by https URL, auto-discover its catalog,
 *  and persist the record. Shared by the REST route and the CLI. */
export async function addAppPluginMarketplaceByUrl(
  store: AppPluginMarketplaceStore,
  opts: { url: string; ref?: string; subdir?: string },
): Promise<{ record: AppPluginMarketplaceRecord }> {
  const { url, ref } = opts
  assertHttpsUrl(url)
  let explicitSubdir: string | undefined
  if (opts.subdir && opts.subdir.trim()) {
    explicitSubdir = opts.subdir.trim()
    const subErr = validateRelativePath(explicitSubdir, { isWindows: process.platform === 'win32' })
    if (subErr) throw new HttpError(400, `invalid subdir: ${subErr}`)
  }
  const id = store.generateId(url)
  const cloneDir = store.cloneDirFor(id)
  await mkdir(dirname(cloneDir), { recursive: true })
  try {
    await gitClone(url, cloneDir, ref ? { ref } : {})
  } catch (err) {
    await rm(cloneDir, { recursive: true, force: true }).catch(() => {})
    throw new HttpError(400, `clone failed: ${(err as Error).message}`)
  }
  let parsed: { subdir?: string; manifest: AppPluginMarketplaceRecord['manifest'] }
  try {
    parsed = await parseAppPluginMarketplaceAuto(cloneDir, explicitSubdir)
  } catch (err) {
    await rm(cloneDir, { recursive: true, force: true }).catch(() => {})
    throw new HttpError(400, `marketplace parse failed: ${(err as Error).message}`)
  }
  const { subdir, manifest } = parsed
  const sha = await gitGetHeadSha(cloneDir)
  const now = Date.now()
  const record: AppPluginMarketplaceRecord = {
    id,
    displayName: manifest.name ?? id,
    source: { type: 'https', url, ref },
    subdir,
    cloneDir,
    addedAt: now,
    lastRefreshedAt: now,
    lastSha: sha,
    manifest,
  }
  store.upsert(record)
  await store.flush()
  return { record }
}
