/**
 * The paths a mutating file tool is about to touch. The snapshot recorder
 * copies each one before the tool runs so files the git snapshots do not
 * cover (gitignored, outside the snapshot scope) still get a before/after
 * comparison.
 *
 * Only first-party file tools are understood; shell commands name no target
 * the host can resolve, and reads never mutate.
 */
import { isAbsolute, join } from 'node:path'

/** The argument that names each supported tool's target. */
const TARGET_FIELDS: Readonly<Record<string, string>> = {
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
}

/**
 * Extract a mutating file tool's target paths.
 * @param toolName - the wire tool name.
 * @param toolInput - the model-produced tool arguments.
 * @param cwd - the session working directory, used for relative targets.
 * @returns one absolute-or-joined path per target; empty for every other tool.
 */
export function toolTargetPaths(toolName: string, toolInput: unknown, cwd: string): string[] {
  const field = TARGET_FIELDS[toolName]
  if (field === undefined || toolInput === null || typeof toolInput !== 'object') return []
  const value = (toolInput as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value.trim() === '') return []
  return [isAbsolute(value) ? value : join(cwd, value)]
}