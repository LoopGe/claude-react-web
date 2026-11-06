// One browser-to-server file transfer, shared by the composer's file drafts.
// The uploads manager keeps its own batch queue (it also copies paths); this
// executor is the single-file primitive for the composer.

import type { FileAttachmentRef } from '../../shared/attachments'

/** A completed upload: the content-facing ref plus the stored path. */
export interface UploadedFile extends FileAttachmentRef {
  readonly path: string
}

export interface UploadFileOptions {
  readonly sessionId?: string
  readonly signal?: AbortSignal
  readonly onProgress?: (loaded: number, total: number) => void
}

interface UploadResponse {
  uploads?: Array<{
    id?: unknown
    path?: unknown
    name?: unknown
    size?: unknown
    digest?: unknown
  }>
}

/** POST one file to the upload route and resolve its registry reference. */
export function uploadFile(file: File, opts: UploadFileOptions = {}): Promise<UploadedFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const query = opts.sessionId === undefined
      ? ''
      : `?sessionId=${encodeURIComponent(opts.sessionId)}`
    xhr.open('POST', `/api/uploads${query}`)

    xhr.upload.onprogress = (event) => {
      opts.onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size)
    }
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(uploadErrorText(xhr)))
        return
      }
      const first = parseFirstUpload(xhr.responseText)
      if (first === null) {
        reject(new Error('Upload response did not include a file reference'))
        return
      }
      resolve(first)
    }
    xhr.onerror = () => reject(new Error('Upload failed'))
    xhr.onabort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))

    if (opts.signal?.aborted === true) {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true })

    const form = new FormData()
    form.append('file', file, file.name)
    xhr.send(form)
  })
}

function uploadErrorText(xhr: XMLHttpRequest): string {
  try {
    const body = JSON.parse(xhr.responseText) as { error?: unknown }
    if (typeof body.error === 'string' && body.error !== '') return body.error
  } catch {
    // Fall through to the status text.
  }
  return `Upload failed (HTTP ${xhr.status})`
}

function parseFirstUpload(body: string): UploadedFile | null {
  try {
    const parsed = JSON.parse(body) as UploadResponse
    const first = parsed.uploads?.[0]
    if (
      first === undefined
      || typeof first.id !== 'string'
      || typeof first.path !== 'string'
      || typeof first.name !== 'string'
      || typeof first.size !== 'number'
      || (first.digest !== undefined && typeof first.digest !== 'string')
    ) {
      return null
    }
    return {
      id: first.id,
      path: first.path,
      name: first.name,
      size: first.size,
      ...(first.digest === undefined ? {} : { digest: first.digest }),
    }
  } catch {
    return null
  }
}