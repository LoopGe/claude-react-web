import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MpEntry, MpStore } from './mp-store.js'
import { assertHttpsUrl, gitClone, gitGetHeadSha, gitBranchName } from './git-clone.js'
import { parseRepoManifest, type ParseWarning } from './marketplace-parser.js'
import { HttpError } from './errors.js'

export interface AddMarketplaceResult {
  entry: MpEntry
  warnings: ParseWarning[]
}

/** Clone a git-repo plugin marketplace by URL, parse its manifest, and
 *  persist the entry. Shared by the REST route and the CLI. */
export async function addMarketplaceByUrl(
  store: MpStore,
  opts: { url: string; ref?: string },
): Promise<AddMarketplaceResult> {
  const { url, ref } = opts
  assertHttpsUrl(url)
  const id = store.generateId(url)
  const cloneDir = store.cloneDirFor(id)
  await mkdir(dirname(cloneDir), { recursive: true })
  await gitClone(url, cloneDir, { ref })
  let parseResult
  try {
    parseResult = await parseRepoManifest(cloneDir)
  } catch (err) {
    try { await rm(cloneDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    throw new HttpError(400, `plugin source parse failed: ${(err as Error).message}`)
  }
  const sha = await gitGetHeadSha(cloneDir)
  const branch = (await gitBranchName(cloneDir)) || ref || undefined
  const now = Date.now()
  const entry: MpEntry = {
    id,
    displayName: parseResult.manifest.name || id,
    source: { type: 'https', url, ref },
    cloneDir,
    addedAt: now,
    lastRefreshedAt: now,
    lastSha: sha,
    branch,
    manifest: parseResult.manifest,
  }
  store.upsert(entry)
  await store.flush()
  return { entry, warnings: parseResult.warnings }
}
