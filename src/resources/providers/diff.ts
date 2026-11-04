// `diff` resource provider (docs/resource-tabs-research.md §13–14 Phase 2).
//
// Reuses the existing git query builders so the resource and the GitPanel rows
// fetch exactly the same body. The value is the preview-capped `GitDiff`; the
// "View full diff" escape hatch (`full=1`) is body-owned.
//
// Invalidation: refetch on ANY `git-snapshot` frame. A range's `to` branch can
// move on commit (a path/root-scoped match would miss it), and Phase 1 does not
// pin background tabs, so only the active body subscribes — at most one diff
// stream per open modal, and frames are already debounced per repo group.

import {
  gitCommitDiffFileQuery,
  gitDiffQuery,
  gitRangeDiffFileQuery,
} from '../../hooks/useGitStatus'
import { api } from '../../hooks/useApi'
import { parseDiffResource, type DiffResource } from '../../../shared/resource-address'
import type { GitDiff } from '../../../shared/git-types'
import { formatError } from '../../utils/format-error'
import type { ResourceFrame, ResourceProvider } from '../registry'
import { failure } from './shared'

type Request = (path: string, init: { signal: AbortSignal }) => Promise<GitDiff>

/** The git route for a diff resource — the single spelling shared by the
 *  provider and the body's full-diff escape hatch. */
export function diffQueryFor(resource: DiffResource, opts?: { full?: boolean }): string {
  const { cwd, path, basis } = resource
  switch (basis.type) {
    case 'worktree':
      return gitDiffQuery(cwd, path, false, opts)
    case 'staged':
      return gitDiffQuery(cwd, path, true, opts)
    case 'commit':
      return gitCommitDiffFileQuery(cwd, basis.sha, path, opts)
    case 'range':
      return gitRangeDiffFileQuery(cwd, basis.from, basis.to, basis.mergeBase, path, opts)
  }
}

export function createDiffProvider(request: Request = api.get): ResourceProvider<GitDiff> {
  return {
    protocol: 'diff',
    async *open(address, ctx) {
      const resource = parseDiffResource(address)
      if (!resource) {
        yield failure('diff/invalid-address', 'This address does not name a diff.')
        return
      }
      const read = async (): Promise<ResourceFrame<GitDiff>> => {
        try {
          return { ok: true, value: await request(diffQueryFor(resource), { signal: ctx.signal }) }
        } catch (error) {
          return failure('diff/fetch-failed', formatError(error))
        }
      }

      // Subscribe before the first read so a frame emitted mid-read is queued.
      const iterator = ctx.invalidations(['git-snapshot'], ctx.signal)[Symbol.asyncIterator]()
      let pending = iterator.next()
      try {
        yield await read()
        for (;;) {
          const { done } = await pending
          if (done) return
          yield await read()
          pending = iterator.next()
        }
      } finally {
        void iterator.return?.()
      }
    },
  }
}