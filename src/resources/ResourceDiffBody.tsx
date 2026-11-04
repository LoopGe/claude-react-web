// Body for a `diff` resource (docs/resource-tabs-research.md §13–14 Phase 2).
// Reuses DiffView for the preview body and FullDiffViewer for the truncation
// escape hatch; the provider value is the same preview-capped GitDiff the Git
// panel rows show.

import { useCallback, useMemo, useState } from 'react'
import { diffBasisLabel, parseDiffResource } from '../../shared/resource-address'
import type { GitDiff } from '../../shared/git-types'
import { api } from '../hooks/useApi'
import { DiffView } from '../components/DiffView'
import { FullDiffViewer } from '../components/FullDiffViewer'
import { useResource } from './useResource'
import { diffQueryFor } from './providers/diff'

export function ResourceDiffBody({ address }: { address: string }) {
  const snapshot = useResource<GitDiff>(address)
  const resource = useMemo(() => parseDiffResource(address), [address])
  const [fullOpen, setFullOpen] = useState(false)
  const showFull = useCallback(() => setFullOpen(true), [])
  const closeFull = useCallback(() => setFullOpen(false), [])
  const fetchFullText = useCallback(
    (signal?: AbortSignal) => {
      if (!resource) return Promise.reject(new Error('invalid diff address'))
      return api
        .get<GitDiff>(diffQueryFor(resource, { full: true }), { signal })
        .then((diff) => diff.text)
    },
    [resource],
  )

  if (!resource) return <div className="hint">Nothing can open this address.</div>

  const diff = snapshot.value
  const error =
    snapshot.status === 'failed' ? (snapshot.failure?.message ?? 'Failed to load the diff.') : null
  const loading = snapshot.status === 'loading' && !diff

  return (
    <div className="resource-diff-body">
      <div className="resource-diff-header">
        <span className="resource-diff-path" title={resource.path}>
          {resource.path}
        </span>
        <span className="resource-diff-basis">{diffBasisLabel(resource.basis)}</span>
      </div>
      {loading && <div className="hint">Loading diff…</div>}
      {error && <div className="field-error">{error}</div>}
      {diff?.isBinary && <div className="hint">(binary file)</div>}
      {diff && !diff.isBinary && (
        <DiffView
          text={diff.text}
          truncated={diff.truncated}
          totalLines={diff.totalLines}
          onShowFull={showFull}
        />
      )}
      <FullDiffViewer
        open={fullOpen}
        onClose={closeFull}
        name={resource.path}
        fetchText={fetchFullText}
      />
    </div>
  )
}