// Body for a `snapshot-diff` resource (docs/resource-tabs-research.md §14
// Phase 2): the changed-file list from a recorded snapshot anchor plus the
// selected file's unified patch (rendered through DiffView). Selection comes
// from navigation params `{ file }` on open and from clicks afterwards; the
// refresh button re-reads the anchor via the registry.

import { useEffect, useState } from 'react'
import type { ResourceParams } from './tab-store'
import type { SnapshotDiffValue } from '../../shared/snapshot-diff'
import { SNAPSHOT_PATCH_TRUNCATION_MARKER } from '../../shared/snapshot-diff'
import { DiffView } from '../components/DiffView'
import { useResourceRegistry } from './context'
import { useResource } from './useResource'

export function ResourceSnapshotDiffBody({
  address,
  params,
  revision,
}: {
  address: string
  params?: ResourceParams
  revision: number
}) {
  const snapshot = useResource<SnapshotDiffValue>(address)
  const registry = useResourceRegistry()
  const [selected, setSelected] = useState<string | null>(null)

  // A reopen (revision bump) or a different tab (address) re-applies the
  // navigation selection.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on navigation
  useEffect(() => setSelected(null), [revision, address])

  const files = snapshot.value?.diffs ?? []
  const paramFile = typeof params?.file === 'string' ? params.file : null
  // Revalidate the selection against the current list: a refresh can drop the
  // previously selected file.
  const requested = selected ?? paramFile
  const activeFile =
    requested && files.some((file) => file.file === requested)
      ? requested
      : (files[0]?.file ?? null)
  const active = files.find((file) => file.file === activeFile) ?? null
  // structuredDiff truncates a large patch and appends a marker; surface the
  // truncation instead of presenting a partial hunk as complete.
  const rawPatch = active?.patch ?? null
  const patchTruncated = rawPatch?.includes(SNAPSHOT_PATCH_TRUNCATION_MARKER) ?? false
  const patchText = rawPatch
    ? rawPatch.replace(
        new RegExp(`\\n?${SNAPSHOT_PATCH_TRUNCATION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`),
        '',
      )
    : null
  const error =
    snapshot.status === 'failed'
      ? (snapshot.failure?.message ?? 'Failed to load the snapshot diff.')
      : null
  const loading = snapshot.status === 'loading' && !snapshot.value

  return (
    <div className="resource-snapshot-body">
      <div className="resource-snapshot-header">
        <span className="resource-snapshot-title">Changes since this message</span>
        <button
          type="button"
          className="btn"
          aria-label="Refresh snapshot diff"
          onClick={() => registry.refresh(address)}
        >
          Refresh
        </button>
      </div>
      {loading && <div className="hint">Loading changes…</div>}
      {error && <div className="field-error">{error}</div>}
      {!loading && !error && files.length === 0 && (
        <div className="hint">No file changes at this anchor.</div>
      )}
      {files.length > 0 && (
        <div className="resource-snapshot-layout">
          <ul className="resource-snapshot-files" aria-label="Changed files">
            {files.map((file) => (
              <li key={file.file}>
                <button
                  type="button"
                  className={`resource-snapshot-file${file.file === activeFile ? ' active' : ''}`}
                  aria-current={file.file === activeFile ? 'true' : undefined}
                  onClick={() => setSelected(file.file)}
                >
                  <span className="resource-snapshot-flag">{file.status.slice(0, 1).toUpperCase()}</span>
                  <span className="resource-snapshot-path">{file.file}</span>
                  <span className="resource-snapshot-stats">
                    +{file.additions} −{file.deletions}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="resource-snapshot-patch">
            {patchText !== null ? (
              <>
                <DiffView
                  text={patchText}
                  truncated={false}
                  totalLines={patchText.split('\n').length}
                />
                {patchTruncated && (
                  <div className="hint">
                    Patch truncated by the server — the rewind preview omits the tail.
                  </div>
                )}
              </>
            ) : (
              <div className="hint">(binary or empty change)</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}