// Unified "Add skill" card for the global settings Skills tab.
//
// One entry for every install source: three source chips (Search catalog /
// Repository / Folder) switch the body, while the install options (scope,
// target project, Replace existing) live in a single shared footer whose
// primary button adapts to the active tab — hidden on Search (rows carry
// their own Install), "Install selected (n)" on Repository, "Install" on
// Folder.
//
// `matchSearchHit` is deliberately fed the PREVIEW response's
// `DiscoveredSkill[]` (clone-relative directories) and never the installed
// `SkillRecord[]` prop: the two share `name`/`description`/`relativePath`
// but `SkillRecord.relativePath` points at SKILL.md relative to cwd, so
// passing the prop typechecks and silently installs the wrong path.

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../hooks/useApi'
import { fileToBase64 } from '../../utils/file-to-base64'
import { directoryMissing } from '../../utils/fs-validation'
import { IconFileText, IconFolder, IconSearch } from '../icons/ToolIcons'
import { DirectoryPicker } from '../DirectoryPicker'
import { ProjectPicker } from '../session-list/ProjectPicker'
import { matchSearchHit, parseOwnerRepo } from '../../../shared/skills'
import type {
  DiscoveredSkill,
  RemoteInstallResponse,
  RemotePreviewResponse,
  RemoteSearchHit,
  SkillImportFile,
  SkillImportResponse,
  SkillRecord,
  SkillScope,
} from '../../../shared/skills'

interface DragFileEntry extends FileSystemEntry {
  file(callback: (file: File) => void, errorCallback?: (error: DOMException) => void): void
}

interface DragDirectoryReader {
  readEntries(callback: (entries: FileSystemEntry[]) => void, errorCallback?: (error: DOMException) => void): void
}

interface DragDirectoryEntry extends FileSystemEntry {
  createReader(): DragDirectoryReader
}

interface DroppedSkillFile {
  file: File
  path: string
}

const readDroppedFile = (entry: DragFileEntry, path: string) => new Promise<DroppedSkillFile>((resolve, reject) => {
  entry.file((file) => resolve({ file, path }), reject)
})

const readDroppedDirectory = async (entry: DragDirectoryEntry, path: string): Promise<DroppedSkillFile[]> => {
  const reader = entry.createReader()
  const entries: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (batch.length === 0) break
    entries.push(...batch)
  }
  const nested = await Promise.all(entries.map((child) => readDroppedEntry(child, `${path}/${child.name}`)))
  return nested.flat()
}

const readDroppedEntry = async (entry: FileSystemEntry, path: string): Promise<DroppedSkillFile[]> => {
  if (entry.isFile) return [await readDroppedFile(entry as DragFileEntry, path)]
  if (entry.isDirectory) return readDroppedDirectory(entry as DragDirectoryEntry, path)
  return []
}

const filesFromDrop = async (dataTransfer: DataTransfer): Promise<Array<File | DroppedSkillFile>> => {
  const entries = Array.from(dataTransfer.items)
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => !!entry)
  if (entries.length === 0) return Array.from(dataTransfer.files)
  const nested = await Promise.all(entries.map((entry) => readDroppedEntry(entry, entry.name)))
  return nested.flat()
}

type SourceTab = 'search' | 'repository' | 'folder'

export function AddSkillCard({
  skills,
  cwd,
  recentCwds,
  importScope,
  onScopeChange,
  onPickTarget,
  onForgetTarget,
  onInstalled,
  onRefresh,
  onImported,
  onBrowseTarget,
}: {
  /** Installed skills — consulted only for the per-scope "Installed" badge
   *  on catalog rows. */
  skills: SkillRecord[]
  /** Effective install target (server default cwd, or the user's pick). */
  cwd: string
  /** Shared recent-projects MRU (same list the New Session dialog offers). */
  recentCwds: string[]
  importScope: SkillScope
  onScopeChange: (scope: SkillScope) => void
  /** Select a target project from the footer dropdown. */
  onPickTarget: (path: string) => void
  /** Forget one recent-project entry (the picker's per-row ✕). */
  onForgetTarget: (path: string) => void
  /** Install SUCCESS funnels here: refresh the installed list AND remember
   *  the project it landed in. */
  onInstalled: () => void
  /** Refresh-only sibling of onInstalled for failure paths — a rejected POST
   *  must not write the shared recent-projects MRU. */
  onRefresh: () => void
  /** A folder import finished — open the imported skill's preview. */
  onImported: (skill: SkillRecord) => void
  /** Open the "Pick a project" directory picker for the footer target. */
  onBrowseTarget: () => void
}) {
  const [tab, setTab] = useState<SourceTab>('search')
  const [replaceExisting, setReplaceExisting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // ── Search catalog tab ────────────────────────────────────────────────

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<RemoteSearchHit[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [installingId, setInstallingId] = useState<string | null>(null)
  /** Installs recorded this session, keyed `${importScope}:${cwd}:${hit.id}` —
   *  a row is only "installed" in the scope AND target it was installed to. */
  const [installedIds, setInstalledIds] = useState<ReadonlySet<string>>(() => new Set())
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const searchAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const q = searchQuery.trim()
    if (!q) {
      searchAbortRef.current?.abort()
      searchAbortRef.current = null
      setSearchResults([])
      setSearchError(null)
      setSearching(false)
      return
    }
    const timer = window.setTimeout(() => {
      searchAbortRef.current?.abort()
      const controller = new AbortController()
      searchAbortRef.current = controller
      setSearching(true)
      setSearchError(null)
      void api
        .get<{ skills: RemoteSearchHit[] }>(`/skills/search?q=${encodeURIComponent(q)}`, { signal: controller.signal })
        .then((res) => {
          if (controller.signal.aborted) return
          setSearchResults(res.skills ?? [])
        })
        .catch((e) => {
          if (controller.signal.aborted) return
          setSearchError((e as Error).message)
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false)
        })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      searchAbortRef.current?.abort()
      searchAbortRef.current = null
    }
  }, [searchQuery])

  const parsedRepo = parseOwnerRepo(searchQuery.trim())

  const installHit = async (hit: RemoteSearchHit) => {
    setInstallingId(hit.id)
    setRowError((prev) => {
      if (!(hit.id in prev)) return prev
      const next = { ...prev }
      delete next[hit.id]
      return next
    })
    try {
      const preview = await api.post<RemotePreviewResponse>('/skills/remote/preview', { source: hit.source }, { timeoutMs: 60_000 })
      const { skill, matchCount } = matchSearchHit(preview.skills, hit)
      if (!skill) {
        setRowError((prev) => ({ ...prev, [hit.id]: 'Not found in ' + hit.source }))
        return
      }
      if (matchCount > 1) {
        setRowError((prev) => ({ ...prev, [hit.id]: matchCount + ' matches — installed the first' }))
      }
      const result = await api.post<RemoteInstallResponse>('/skills/remote/install', {
        source: hit.source,
        scope: importScope,
        cwd: importScope === 'project' ? cwd : undefined,
        paths: [skill.relativePath],
        overwrite: replaceExisting,
      }, { timeoutMs: 60_000 })
      if (result.failed.length > 0) {
        setRowError((prev) => ({ ...prev, [hit.id]: result.failed[0].error }))
        return
      }
      setInstalledIds((prev) => new Set(prev).add(`${importScope}:${cwd}:${hit.id}`))
      onInstalled()
    } catch (e) {
      setRowError((prev) => ({ ...prev, [hit.id]: (e as Error).message }))
      // The POST may still have landed files before the failure (or the 409
      // came from a stale list) — the GET is the source of truth either way.
      onRefresh()
    } finally {
      setInstallingId(null)
    }
  }

  // ── Repository tab — inline checklist (replaces the old batch modal) ──

  const [repoInput, setRepoInput] = useState('')
  const [repoSource, setRepoSource] = useState<string | null>(null)
  // Bumped on every explicit open so opening the SAME source refetches —
  // a failed preview must be retryable (setRepoSource alone would bail out).
  const [repoFetchKey, setRepoFetchKey] = useState(0)
  const [repoSkills, setRepoSkills] = useState<DiscoveredSkill[]>([])
  const [repoLoading, setRepoLoading] = useState(false)
  const [repoError, setRepoError] = useState<string | null>(null)
  const [repoFilter, setRepoFilter] = useState('')
  const [repoSelected, setRepoSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [batchInstalling, setBatchInstalling] = useState(false)
  const [batchResults, setBatchResults] = useState<RemoteInstallResponse | null>(null)

  useEffect(() => {
    if (!repoSource) return
    let live = true
    setRepoLoading(true)
    setRepoError(null)
    setRepoSkills([])
    setRepoSelected(new Set())
    setRepoFilter('')
    setBatchResults(null)
    void api.post<RemotePreviewResponse>('/skills/remote/preview', { source: repoSource }, { timeoutMs: 60_000 })
      .then((res) => {
        if (live) setRepoSkills(res.skills ?? [])
      })
      .catch((e) => {
        if (live) setRepoError((e as Error).message)
      })
      .finally(() => {
        if (live) setRepoLoading(false)
      })
    return () => { live = false }
  }, [repoSource, repoFetchKey])

  /** Switch to the Repository tab with `source` prefilled and its checklist
   *  loading — the destination of every "Open repo" / "Open repository". */
  const openRepo = (source: string) => {
    const trimmed = source.trim()
    if (!trimmed) return
    setRepoInput(trimmed)
    setRepoSource(trimmed)
    setRepoFetchKey((k) => k + 1)
    setTab('repository')
  }

  const visibleRepoSkills = useMemo(() => {
    const q = repoFilter.trim().toLowerCase()
    if (!q) return repoSkills
    return repoSkills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    )
  }, [repoSkills, repoFilter])

  // Install outcome per row, keyed by relativePath.
  const batchStatus = useMemo(() => {
    const map = new Map<string, { ok: boolean; text: string }>()
    if (!batchResults) return map
    for (const item of batchResults.installed) map.set(item.relativePath, { ok: true, text: '✓' })
    for (const item of batchResults.failed) map.set(item.relativePath, { ok: false, text: item.error })
    return map
  }, [batchResults])

  // Select All covers only rows that aren't already installed this session —
  // re-selecting a succeeded row would re-POST it and paint a 409 over a
  // correct install. Manual ticking still allows a deliberate re-install.
  const selectableRepoSkills = visibleRepoSkills.filter((s) => batchStatus.get(s.relativePath)?.ok !== true)
  const allVisibleSelected = selectableRepoSkills.length > 0 && selectableRepoSkills.every((s) => repoSelected.has(s.relativePath))
  const toggleAllVisible = () => {
    const next = new Set(repoSelected)
    for (const s of selectableRepoSkills) {
      if (allVisibleSelected) next.delete(s.relativePath)
      else next.add(s.relativePath)
    }
    setRepoSelected(next)
  }
  const toggleOne = (path: string) => {
    const next = new Set(repoSelected)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setRepoSelected(next)
  }

  const installBatch = async () => {
    setBatchInstalling(true)
    setRepoError(null)
    setBatchResults(null)
    try {
      const result = await api.post<RemoteInstallResponse>('/skills/remote/install', {
        source: repoSource,
        scope: importScope,
        cwd: importScope === 'project' ? cwd : undefined,
        paths: [...repoSelected],
        overwrite: replaceExisting,
      }, { timeoutMs: 60_000 })
      setBatchResults(result)
      // Drop the succeeded paths from the selection: re-POSTing them would
      // 409 'Skill already exists' and paint red over correctly installed
      // rows. Failures stay selected so one click retries them.
      const succeeded = new Set(result.installed.map((item) => item.relativePath))
      setRepoSelected((prev) => new Set([...prev].filter((p) => !succeeded.has(p))))
      // Success only when something landed — a fully-failed batch must not
      // write the shared recent-projects MRU.
      if (result.installed.length > 0) onInstalled()
      else onRefresh()
    } catch (e) {
      // The POST may still have landed files before the failure — the GET is
      // the source of truth, so refresh either way.
      setRepoError((e as Error).message)
      onRefresh()
    } finally {
      setBatchInstalling(false)
    }
  }

  // ── Folder tab — local / server-side directory import ─────────────────

  const [importPath, setImportPath] = useState('')
  const [importName, setImportName] = useState('')
  const [showImportPicker, setShowImportPicker] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [importingSkill, setImportingSkill] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const directoryInputProps = { webkitdirectory: '', directory: '' } as Record<string, string>

  // Any install in flight. Everything that affects a running install (scope,
  // target, Replace existing, repo switching, further installs) disables
  // while busy — three independent busy flags otherwise allow concurrent
  // POSTs into the same target and let results cross lists on a repo switch.
  const busy = batchInstalling || installingId !== null || importingSkill

  // Validate the current install target on mount / target change / window
  // focus (so recreating a deleted directory lifts the block again). Only a
  // confirmed-gone directory (404, or a FILE at that path) blocks installs;
  // any other failure fails OPEN. Results are keyed by path so a target
  // switch never applies the previous target's verdict.
  const [targetCheck, setTargetCheck] = useState<{ path: string; missing: boolean } | null>(null)
  useEffect(() => {
    // User-scope installs never touch the project cwd — skip the check (and
    // the focus revalidation) entirely while user scope is active.
    if (!cwd || importScope === 'user') return
    let controller: AbortController | null = null
    const check = () => {
      controller?.abort()
      controller = new AbortController()
      const signal = controller.signal
      // A fresh check means UNKNOWN until it resolves — never keep the
      // previous verdict alive through the revalidation window.
      setTargetCheck(null)
      void directoryMissing(cwd, signal).then((missing) => {
        if (signal.aborted) return
        setTargetCheck({ path: cwd, missing })
      })
    }
    check()
    window.addEventListener('focus', check)
    return () => {
      controller?.abort()
      window.removeEventListener('focus', check)
    }
  }, [cwd, importScope])

  // Installing into a moved/deleted directory would silently recreate it —
  // block every install affordance and say why instead. A target whose check
  // is still pending is UNKNOWN, not known-good, so it blocks too.
  const targetMissing = importScope === 'project' && targetCheck?.path === cwd && targetCheck.missing
  const targetUnknown = importScope === 'project' && !!cwd && targetCheck?.path !== cwd
  const installBlocked = busy || targetMissing || targetUnknown

  const finishImport = (result: SkillImportResponse) => {
    setNotice(`Imported ${result.skill.scope} skill "${result.skill.name}" from ${result.importedFiles} file${result.importedFiles !== 1 ? 's' : ''}.`)
    setImportName('')
    onInstalled()
    onImported(result.skill)
  }

  const importFromServerPath = async (path: string = importPath) => {
    if (installBlocked) return
    const trimmedPath = path.trim()
    if (!trimmedPath) return
    setImportingSkill(true)
    setError(null)
    setNotice(null)
    try {
      const result = await api.post<SkillImportResponse>('/skills/import/path', {
        scope: importScope,
        cwd: importScope === 'project' ? cwd : undefined,
        path: trimmedPath,
        name: importName.trim() || undefined,
        overwrite: replaceExisting,
      }, { timeoutMs: 60_000 })
      setImportPath(trimmedPath)
      finishImport(result)
    } catch (e) {
      setError((e as Error).message)
      // The POST may still have landed files before the failure — refresh
      // so the list reflects whatever ended up on disk.
      onRefresh()
    } finally {
      setImportingSkill(false)
    }
  }

  const importBrowserFiles = async (files: Array<File | DroppedSkillFile>) => {
    if (installBlocked || files.length === 0) return
    setImportingSkill(true)
    setError(null)
    setNotice(null)
    try {
      const payload: SkillImportFile[] = await Promise.all(files.map(async (item) => {
        const file = item instanceof File ? item : item.file
        const path = item instanceof File ? (file.webkitRelativePath || file.name) : item.path
        return {
          path: path.replace(/^\/+/, ''),
          data: await fileToBase64(file),
          encoding: 'base64' as const,
        }
      }))
      const result = await api.post<SkillImportResponse>('/skills/import/files', {
        scope: importScope,
        cwd: importScope === 'project' ? cwd : undefined,
        name: importName.trim() || undefined,
        overwrite: replaceExisting,
        files: payload,
      }, { timeoutMs: 60_000 })
      finishImport(result)
    } catch (e) {
      setError((e as Error).message)
      // The POST may still have landed files before the failure — refresh
      // so the list reflects whatever ended up on disk.
      onRefresh()
    } finally {
      setImportingSkill(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDrop = (event: React.DragEvent<HTMLElement>) => {
    // Always claim the drop (no browser file navigation) and clear the drag
    // highlight — the busy/missing gate only stops the import itself.
    event.preventDefault()
    setDragActive(false)
    if (installBlocked) return
    // Walking the dropped folder is itself an in-flight import: hold busy
    // from the drop until the read AND the import settle.
    setImportingSkill(true)
    void filesFromDrop(event.dataTransfer)
      .then((files) => importBrowserFiles(files))
      .catch((e) => {
        setNotice(null)
        setError((e as Error).message)
      })
      .finally(() => setImportingSkill(false))
  }

  return (
    <section className="settings-group settings-skill-add-group">
      <div className="settings-group-head">
        <h4>Add skill</h4>
        <span className="settings-group-desc">Install from the public catalog, a GitHub repository, or a local / server-side folder.</span>
      </div>
      <div className="settings-group-body">
        <div className="settings-skill-source-tabs">
          <button
            type="button"
            className={`settings-skill-source-btn${tab === 'search' ? ' active' : ''}`}
            onClick={() => setTab('search')}
          >
            Search catalog
          </button>
          <button
            type="button"
            className={`settings-skill-source-btn${tab === 'repository' ? ' active' : ''}`}
            onClick={() => setTab('repository')}
          >
            Repository
          </button>
          <button
            type="button"
            className={`settings-skill-source-btn${tab === 'folder' ? ' active' : ''}`}
            onClick={() => setTab('folder')}
          >
            Folder
          </button>
        </div>

        {tab === 'search' && (
          <div className="settings-skill-search-body">
            <div className="settings-skill-remote-head">
              <input
                className="input"
                aria-label="Search skills"
                placeholder="Search skills.sh or paste owner/repo"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                spellCheck={false}
              />
              {searching && <span className="settings-note">Searching…</span>}
            </div>
            {searchError && <div className="settings-error">{searchError}</div>}
            {parsedRepo && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => openRepo(parsedRepo.owner + '/' + parsedRepo.repo)}
              >
                Open repository
              </button>
            )}
            {searchResults.map((hit) => {
              const installed =
                installedIds.has(`${importScope}:${cwd}:${hit.id}`) ||
                skills.some((s) => s.scope === importScope && s.name === hit.name)
              return (
                <div key={hit.id} className="settings-skill-result-row">
                  <span className="settings-skill-result-name">{hit.name}</span>
                  <span className="settings-skill-result-source">{hit.source}</span>
                  <span className="settings-skill-result-installs">{hit.installs.toLocaleString()}</span>
                  {installed ? (
                    <span className="settings-skill-installed-badge">✓ Installed</span>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      disabled={installBlocked}
                      onClick={() => void installHit(hit)}
                    >
                      {installingId === hit.id ? 'Installing…' : 'Install'}
                    </button>
                  )}
                  <button type="button" className="btn" disabled={busy} onClick={() => openRepo(hit.source)}>
                    Open repo
                  </button>
                  {rowError[hit.id] && <div className="settings-skill-row-error">{rowError[hit.id]}</div>}
                </div>
              )
            })}
          </div>
        )}

        {tab === 'repository' && (
          <div className="settings-skill-repo-body">
            <div className="settings-skill-remote-head">
              <input
                className="input"
                aria-label="Repository source"
                placeholder="owner/repo or GitHub URL"
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                spellCheck={false}
              />
              <button
                type="button"
                className="btn"
                disabled={busy || !repoInput.trim()}
                onClick={() => openRepo(repoInput)}
              >
                Open repository
              </button>
            </div>
            {repoSource && (
              <>
                <div className="settings-skill-picker-sub">{`${repoSource} · ${repoSkills.length} skills found`}</div>
                <div className="settings-skill-picker-toolbar">
                  <label className="settings-skill-picker-search">
                    <IconSearch size={13} aria-hidden />
                    <input
                      value={repoFilter}
                      onChange={(e) => setRepoFilter(e.target.value)}
                      placeholder="Search skills…"
                      aria-label="Filter skills"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </label>
                  <label className="settings-skill-picker-select-all">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAllVisible}
                      disabled={batchInstalling}
                    />
                    <span>{`Select All (${repoSelected.size}/${repoSkills.length})`}</span>
                  </label>
                </div>
                {repoError && <div className="settings-error">{repoError}</div>}
                {repoLoading && <div className="settings-note">Loading…</div>}
                <div className="settings-skill-picker-list">
                  {visibleRepoSkills.map((skill) => {
                    const status = batchStatus.get(skill.relativePath)
                    return (
                      <label key={skill.relativePath} className="settings-skill-picker-row">
                        <input
                          type="checkbox"
                          checked={repoSelected.has(skill.relativePath)}
                          onChange={() => toggleOne(skill.relativePath)}
                          disabled={batchInstalling}
                        />
                        <span>
                          <strong>{skill.name}</strong>
                          <small title={skill.description}>{skill.description}</small>
                        </span>
                        {status && (
                          <span
                            className={`settings-skill-picker-status${status.ok ? '' : ' error'}`}
                            title={status.text}
                          >
                            {status.text}
                          </span>
                        )}
                      </label>
                    )
                  })}
                </div>
                {batchResults && (
                  <div className="settings-skill-picker-summary">
                    {`${batchResults.installed.length} installed${batchResults.failed.length ? ` · ${batchResults.failed.length} failed` : ''}`}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'folder' && (
          <div
            className={`settings-skill-folder-body${dragActive ? ' dragging' : ''}`}
            onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { if (event.currentTarget === event.target) setDragActive(false) }}
            onDrop={handleDrop}
          >
            <div className="settings-skill-drop">
              <span>
                Drop a folder containing <code>SKILL.md</code> here
              </span>
              <button
                type="button"
                className="btn"
                disabled={installBlocked}
                onClick={() => fileInputRef.current?.click()}
              >
                <IconFileText size={14} /> Choose local folder
              </button>
            </div>
            <div className="settings-note">Or install from a server path:</div>
            <div className="settings-skill-path-row">
              <input
                className="input"
                placeholder="Absolute server path to a skill folder"
                aria-label="Server path to skill folder"
                value={importPath}
                onChange={(event) => setImportPath(event.target.value)}
                spellCheck={false}
              />
              <button
                type="button"
                className="btn"
                onClick={() => setShowImportPicker(true)}
                disabled={installBlocked}
              >
                <IconFolder size={14} /> Choose folder
              </button>
            </div>
            <input
              className="input"
              placeholder="Optional import name"
              aria-label="Import name"
              value={importName}
              onChange={(event) => setImportName(event.target.value)}
            />
            <span className="settings-note">Directory upload works in Chromium-based browsers; drag-and-drop uses the same importer.</span>
            <input
              ref={fileInputRef}
              className="settings-skill-file-input"
              type="file"
              multiple
              onChange={(event) => void importBrowserFiles(Array.from(event.currentTarget.files ?? []))}
              {...directoryInputProps}
            />
            {error && <div className="settings-error">{error}</div>}
            {notice && <div className="settings-success">{notice}</div>}
          </div>
        )}

        <div className="settings-skill-add-footer">
          <div className="settings-scope-toggle">
            <button
              type="button"
              className={`settings-scope-btn${importScope === 'project' ? ' active' : ''}`}
              disabled={busy}
              onClick={() => onScopeChange('project')}
            >
              Project
            </button>
            <button
              type="button"
              className={`settings-scope-btn${importScope === 'user' ? ' active' : ''}`}
              disabled={busy}
              onClick={() => onScopeChange('user')}
            >
              User
            </button>
          </div>
          <div className="settings-skill-target">
            <ProjectPicker
              id="skills-target-project"
              ariaLabel="Target project"
              disabled={importScope === 'user' || busy}
              value={cwd}
              recents={recentCwds}
              onSelect={onPickTarget}
              onForget={onForgetTarget}
              onBrowse={onBrowseTarget}
            />
          </div>
          {importScope === 'project' && (
            <div className="settings-skill-target-hint">{`${cwd}/.claude/skills`}</div>
          )}
          {targetMissing && <span className="settings-note warn">Target project directory does not exist</span>}
          <label className="settings-skill-overwrite">
            <input
              type="checkbox"
              checked={replaceExisting}
              disabled={busy}
              onChange={(e) => setReplaceExisting(e.target.checked)}
            />{' '}
            Replace existing
          </label>
          {tab === 'repository' && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={installBlocked || repoSelected.size === 0}
              onClick={() => void installBatch()}
            >
              {batchInstalling ? 'Installing…' : `Install selected (${repoSelected.size})`}
            </button>
          )}
          {tab === 'folder' && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={installBlocked || !importPath.trim()}
              onClick={() => void importFromServerPath()}
            >
              {importingSkill ? 'Installing…' : 'Install'}
            </button>
          )}
        </div>
      </div>

      {showImportPicker && (
        <DirectoryPicker
          title="Pick a skill folder"
          selectLabel="Install this folder"
          footerHint="Select a folder that contains SKILL.md"
          initialPath={importPath || cwd}
          onPick={(path) => {
            setImportPath(path)
            setShowImportPicker(false)
            void importFromServerPath(path)
          }}
          onClose={() => setShowImportPicker(false)}
        />
      )}
    </section>
  )
}
