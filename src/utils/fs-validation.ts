import { api } from '../hooks/useApi'

/** Whether a directory is confirmed GONE — 404 from /fs/resolve-cwd, or a
 *  regular file sitting at that path (resolvedFromFile). Every other failure
 *  fails OPEN (false): a flaky check must not lock the user out of a
 *  directory that may be perfectly fine. Shared by ProjectPicker's row
 *  validation and AddSkillCard's install-target guard so the two can never
 *  drift on what "missing" means. */
export async function directoryMissing(path: string, signal: AbortSignal): Promise<boolean> {
  try {
    const res = await api.get<{ cwd: string; resolvedFromFile: boolean }>(`/fs/resolve-cwd?path=${encodeURIComponent(path)}`, { signal })
    return res.resolvedFromFile === true
  } catch (e) {
    return (e as { status?: number }).status === 404
  }
}
