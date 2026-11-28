// server/providers/native/tools/read.ts
import { isAbsolute, join, resolve, sep } from 'node:path'
import {
  MODEL_READ_MAX_LINES,
  NativeFileChangedError,
  NativeFileEncodingError,
  NativeFileUnavailableError,
  NativeReadWindowTooLargeError,
  readNativeBytes,
  readNativePrefix,
  readNativeTextWindow,
  resolveNativeReadTarget,
} from '../file-read.js'
import { IMAGE_MAX_BYTES, sniffNativeMediaKind } from '../image-documents.js'
import { renderNotebook } from '../notebook.js'
import { PDF_MAX_BYTES } from '../pdf-documents.js'
import type { NativeReadState } from '../read-state.js'
import {
  imageOutcomeFromBytes,
  mediaDisplayName,
  pdfOutcomeFromBytes,
  safeMediaReadReason,
  type NativeMediaReadDeps,
} from './media-read.js'
import { ToolInputError, type ToolDef } from './types.js'

const MAX_LINES = MODEL_READ_MAX_LINES
/** A notebook is parsed and re-rendered whole, so its raw document has to fit
 *  in memory before pagination applies to the rendered lines. */
const NOTEBOOK_MAX_BYTES = 8 * 1024 * 1024

/** Resolve a user-supplied path against the session cwd and refuse anything
 *  that escapes it. P1 keeps the sandbox closed; the sandbox setting plumbs
 *  through in P3. `extraRoots` (the auto-memory write roots) widen the lexical
 *  allowance beyond the cwd; this chain stays lexical — the realpath escape
 *  check lives in resolveNativeReadTarget on the Edit/Read chain. */
export function resolveAgainstCwd(cwd: string, p: string, extraRoots?: readonly string[]): string {
  if (typeof p !== 'string' || p === '') throw new ToolInputError('path is required')
  const abs = isAbsolute(p) ? resolve(p) : resolve(join(cwd, p))
  const roots = [resolve(cwd), ...(extraRoots ?? []).map((root) => resolve(root))]
  if (!roots.some((root) => abs === root || abs.startsWith(root + sep))) {
    throw new ToolInputError(`path escapes the session working directory: ${p}`)
  }
  return abs
}

/** Publish a working-directory file's bytes into the content-addressed store
 *  so later rounds project the same bytes without touching the file again. */
function publishOccurrence(deps: NativeMediaReadDeps, bytes: Buffer, name: string, signal: AbortSignal) {
  const port = deps.attachmentPort
  if (!port?.publish) throw new ToolInputError('PDF reading is unavailable in this host: no attachment store is wired')
  return port.publish({
    chunks: (async function* () { yield bytes })(),
    name,
    maxBytes: PDF_MAX_BYTES,
    signal,
  })
}

export function createReadTool(
  state: NativeReadState,
  media: NativeMediaReadDeps = {},
): ToolDef<{
  file_path: string
  offset?: number
  limit?: number
}> {
  return {
    name: 'Read',
    description: 'Read a file and return line-numbered text, or the image / PDF content for media files.',
    guidance: 'Read a file before editing or writing it; paths resolve inside the session working directory. Images and PDFs are returned as model-visible content, not as text.',
    promptOrder: 100,
    readOnlyHint: true,
    schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to read, relative to the session working directory.' },
        offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
        limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${MAX_LINES}.` },
      },
      required: ['file_path'],
    },
    async run(input, ctx) {
      const offset = Math.max(1, Math.floor(input.offset ?? 1))
      const limit = Math.min(MAX_LINES, Math.max(1, Math.floor(input.limit ?? MAX_LINES)))
      try {
        const target = await resolveNativeReadTarget(ctx.cwd, input.file_path, ctx.memoryRoots?.read)
        const kind = sniffNativeMediaKind(await readNativePrefix(target, 16, ctx.signal))
        if (kind === 'image') {
          if (offset !== 1 || input.limit !== undefined) {
            throw new ToolInputError('images do not accept offset or limit pagination')
          }
          const size = Number(target.identity.size)
          if (size > IMAGE_MAX_BYTES) {
            throw new ToolInputError('image exceeds the 5 MiB per-image limit; resize or re-encode it before reading')
          }
          return await imageOutcomeFromBytes(media, ctx, {
            bytes: await readNativeBytes(target, IMAGE_MAX_BYTES, ctx.signal),
            name: mediaDisplayName(target.absolutePath),
          })
        }
        if (kind === 'pdf') {
          if (offset !== 1 || input.limit !== undefined) {
            throw new ToolInputError('PDF documents do not accept offset or limit pagination')
          }
          const size = Number(target.identity.size)
          if (size > PDF_MAX_BYTES) {
            throw new ToolInputError('PDF exceeds the 20 MiB document limit')
          }
          const bytes = await readNativeBytes(target, PDF_MAX_BYTES, ctx.signal)
          const name = mediaDisplayName(target.absolutePath)
          const published = await publishOccurrence(media, bytes, name, ctx.signal)
          return await pdfOutcomeFromBytes(media, ctx, {
            bytes,
            context: `File: ${name}`,
            attachment: {
              id: `sha256:${published.digest}`,
              name,
              size: published.size,
              digest: published.digest,
              path: published.objectPath,
              mediaType: 'application/pdf',
              modelForm: 'pdf-document',
            },
          })
        }
        if (offset === 1 && input.limit === undefined && state.unchangedSinceRead(target)) {
          return {
            text: `Wasted call — ${mediaDisplayName(target.absolutePath)} is unchanged since your last Read. `
              + 'Refer to the content you already have; read it again only after it changes.',
          }
        }
        if (/\.ipynb$/i.test(target.absolutePath)) {
          const size = Number(target.identity.size)
          if (size > NOTEBOOK_MAX_BYTES) {
            throw new ToolInputError('notebook exceeds the 8 MiB notebook limit')
          }
          const rendered = renderNotebook((await readNativeBytes(target, NOTEBOOK_MAX_BYTES, ctx.signal)).toString('utf8'))
          if (rendered !== undefined) {
            const lines = rendered.split('\n')
            const selected = lines.slice(offset - 1, offset - 1 + limit)
            if (selected.length === 0) return { text: '' }
            return { text: selected.map((line, i) => `${String(offset + i).padStart(6)}\t${line}`).join('\n') }
          }
        }
        const continuation = offset > 1 ? state.continuation(target, offset) : undefined
        const window = await readNativeTextWindow(target, {
          offset,
          limit,
          ...(continuation ? { startByteOffset: continuation.byteOffset } : {}),
          signal: ctx.signal,
        })
        state.recordModelWindow(window, continuation !== undefined)
        const lineCount = Math.max(0, window.endLine - window.startLine + 1)
        const lines = lineCount === 0 ? [] : window.text.split('\n')
        const text = lines.map((line, i) => `${String(offset + i).padStart(6)}\t${line}`).join('\n')
        return { text }
      } catch (err) {
        const mediaReason = safeMediaReadReason(err)
        if (mediaReason !== undefined) throw new ToolInputError(mediaReason)
        if (err instanceof NativeFileUnavailableError
          || err instanceof NativeFileEncodingError
          || err instanceof NativeFileChangedError
          || err instanceof NativeReadWindowTooLargeError) {
          throw new ToolInputError(err.message)
        }
        throw err
      }
    },
  }
}
