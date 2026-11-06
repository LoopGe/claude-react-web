import type { DraftFile } from '../hooks/useFileDrafts'
import { formatBytes } from '../utils/format'
import { IconFileText, IconX } from './icons/ToolIcons'

/** Draft file chips: upload progress, failure/retry, removal, and a
 *  ready-state link to the stored copy. Mirrors ComposerImagePreviews. */
export function ComposerFilePreviews({
  files,
  onRemove,
  onRetry,
}: {
  files: readonly DraftFile[]
  onRemove: (key: string) => void
  onRetry: (key: string) => void
}) {
  return (
    <div className="file-previews">
      {files.map((file) => {
        const name = file.upload?.name ?? file.file?.name ?? 'file'
        const size = file.upload?.size ?? file.total
        const progress = file.total > 0 ? file.loaded / file.total : 0
        const contentUrl = file.upload === undefined
          ? undefined
          : `/api/uploads/${encodeURIComponent(file.upload.id)}/content`
        const body = (
          <>
            <IconFileText size={16} className="file-preview-icon" />
            <span className="file-preview-name">{name}</span>
            <span className="file-preview-meta">
              {file.status === 'uploading'
                ? 'Uploading…'
                : file.status === 'error'
                  ? file.error ?? 'Upload failed'
                  : formatBytes(size)}
            </span>
          </>
        )
        return (
          <div
            key={file.key}
            className={`file-preview-card${file.status === 'error' ? ' file-preview-failed' : ''}`}
          >
            {contentUrl === undefined
              ? <span className="file-preview-body" title={name}>{body}</span>
              : (
                <a
                  className="file-preview-body"
                  href={contentUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={name}
                >
                  {body}
                </a>
              )}
            {file.status === 'error' && file.file !== undefined && (
              <button type="button" className="file-preview-retry" onClick={() => onRetry(file.key)}>
                Retry
              </button>
            )}
            <button
              type="button"
              className="file-preview-remove"
              aria-label={`Remove ${name}`}
              onClick={() => onRemove(file.key)}
            >
              <IconX size={12} />
            </button>
            {file.status === 'uploading' && (
              <span className="file-preview-track" aria-hidden>
                <span
                  className="file-preview-bar"
                  style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
                />
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}