// `snapshot-diff` resource provider (docs/resource-tabs-research.md §14 Phase 2).
// Reads the structured diff from a recorded snapshot anchor. No invalidation
// source: the anchor diff changes only when the worktree does, and the body
// offers an explicit refresh (registry.refresh).

import { api } from '../../hooks/useApi'
import { parseSnapshotDiffResource } from '../../../shared/resource-address'
import type { SnapshotDiffValue } from '../../../shared/snapshot-diff'
import { formatError } from '../../utils/format-error'
import type { ResourceProvider } from '../registry'
import { failure } from './shared'

type Request = (path: string, init: { signal: AbortSignal }) => Promise<SnapshotDiffValue>

export function createSnapshotDiffProvider(
  request: Request = api.get,
): ResourceProvider<SnapshotDiffValue> {
  return {
    protocol: 'snapshot-diff',
    async *open(address, ctx) {
      const resource = parseSnapshotDiffResource(address)
      if (!resource) {
        yield failure('snapshot-diff/invalid-address', 'This address does not name a snapshot diff.')
        return
      }
      try {
        yield {
          ok: true,
          value: await request(
            `/sessions/${resource.sessionId}/snapshot-diff?from=${encodeURIComponent(resource.messageId)}`,
            { signal: ctx.signal },
          ),
        }
      } catch (error) {
        yield failure('snapshot-diff/fetch-failed', formatError(error))
      }
    },
  }
}