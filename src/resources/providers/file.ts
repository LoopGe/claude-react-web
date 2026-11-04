// `file` resource provider (docs/resource-tabs-research.md §13).
//
// Reads through the existing live-only `/sessions/:id/read-file` route. Unlike
// dsh's metadata-only file value, our route returns the (capped) content in one
// response, so the resource value IS what the body renders. A denied/missing
// read is passed through as a VALUE (`available: false`) so the body shows its
// neutral hint; only a transport failure becomes a failure frame.
//
// No disk fallback is added speculatively: a dormant session yields a clear
// `file/read-failed` failure, which the modal shows instead of a blank.
//
// Invalidation: a `git-snapshot` frame refetches when its work tree contains
// the file. The subscription is opened BEFORE the first read so a snapshot that
// lands during that read is buffered rather than lost. We deliberately do not
// compare against the frame's changed-file set — a file modified then committed
// disappears from status, so the path-scope check is the honest one;
// git-snapshot is debounced per repo group.

import { api } from '../../hooks/useApi'
import { parseFileResource } from '../../../shared/resource-address'
import { imageMediaTypeOf } from '../../utils/file-display'
import { formatError } from '../../utils/format-error'
import { isPathInside } from '../../../shared/app-plugins/path-security'
import { IMAGE_PREVIEW_MAX_BYTES, type FileReadResult } from '../../../shared/read-file'
import type { InvalidationSource, ResourceFrame, ResourceProvider } from '../registry'
import { failure } from './shared'

type Request = (path: string, init: { signal: AbortSignal }) => Promise<FileReadResult>

function isUnder(path: string, root: string): boolean {
  // Addresses are `/`-normalized, git frames may carry drive letters/backslashes.
  const isWindows = /^[A-Za-z]:/.test(path) || path.includes('\\')
  return isPathInside(path, root, { isWindows })
}

/** `git-snapshot` frames carry the work tree they describe; only frames whose
 *  cwd/repoRoot contain the file are relevant to it. */
function frameTouchesFile(frame: unknown, filePath: string): boolean {
  if (typeof frame !== 'object' || frame === null) return false
  const candidate = frame as { kind?: unknown; cwd?: unknown; repoRoot?: unknown }
  if (candidate.kind !== 'git-snapshot') return false
  return [candidate.repoRoot, candidate.cwd].some(
    (root) => typeof root === 'string' && isUnder(filePath, root),
  )
}

export function createFileProvider(request: Request = api.get): ResourceProvider<FileReadResult> {
  return {
    protocol: 'file',
    async *open(address, ctx) {
      const parsed = parseFileResource(address)
      if (!parsed) {
        yield failure('file/invalid-address', 'This address does not name a file.')
        return
      }
      const requestPath = (): string =>
        `/sessions/${parsed.sessionId}/read-file?path=${encodeURIComponent(parsed.path)}` +
        (imageMediaTypeOf(parsed.path)
          ? `&encoding=base64&maxBytes=${IMAGE_PREVIEW_MAX_BYTES}`
          : '')

      const read = async (): Promise<ResourceFrame<FileReadResult>> => {
        try {
          const result = await request(requestPath(), { signal: ctx.signal })
          return { ok: true, value: result }
        } catch (error) {
          return failure('file/read-failed', formatError(error))
        }
      }

      // Subscribe before the first read: a frame emitted while the read is in
      // flight is queued by the source and processed right after it.
      const iterator = ctx.invalidations(['git-snapshot'], ctx.signal)[Symbol.asyncIterator]()
      let pending = iterator.next()
      try {
        yield await read()
        for (;;) {
          const { done, value } = await pending
          if (done) return
          if (frameTouchesFile(value, parsed.path)) yield await read()
          pending = iterator.next()
        }
      } finally {
        void iterator.return?.()
      }
    },
  }
}

export type { InvalidationSource }