import type { FileAttachmentRef } from '../../../shared/attachments'
import { formatBytes } from '../../utils/format'
import { IconFileText } from '../icons/ToolIcons'

/** File chips for one rendered user message. Live messages carry structured
 *  FileBlocks; replay/disk messages recover the same refs from the handle
 *  text (see `splitUserBlocks`). Clicking opens the stored copy. */
export function UserFileAttachments({ files }: { files: readonly FileAttachmentRef[] }) {
  return (
    <div className="msg-file-row">
      {files.map((file) => (
        <a
          key={file.id}
          className="msg-file-chip"
          href={`/api/uploads/${encodeURIComponent(file.id)}/content`}
          target="_blank"
          rel="noreferrer"
          title={file.name}
        >
          <IconFileText size={14} className="msg-file-icon" />
          <span className="msg-file-name">{file.name}</span>
          <span className="msg-file-size">{formatBytes(file.size)}</span>
        </a>
      ))}
    </div>
  )
}