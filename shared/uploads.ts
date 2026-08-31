// Uploaded-file registry types shared by the server (store + routes) and
// the client (manager dialog). Browser-safe: no Node imports.

/** One recorded upload. `path` is the unique key (dest names embed a
 *  millisecond timestamp, so same-cwd collisions cannot occur); `id`
 *  exists for routes and UI keys. `cwd` is the ownership key (forks share
 *  a cwd); `sessionTitle` is a provenance snapshot taken at upload time —
 *  a deleted session must not take the record with it. */
export interface UploadEntry {
  id: string
  path: string
  cwd: string
  name: string
  size: number
  uploadedAt: number
  sessionTitle: string
}

/** UploadEntry + a live on-disk existence flag computed by GET /uploads. */
export type UploadListItem = UploadEntry & { exists: boolean }

export interface UploadsListResponse {
  uploads: UploadListItem[]
}
