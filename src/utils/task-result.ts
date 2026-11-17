import type { TaskRecordUi } from '../../shared/tasks'
import type { ActiveSubagent } from '../session-store/types'
import { taskResultVersionForText } from '../../shared/tasks'
import { resultContentToText } from '../session-store/live-turn'

/** Match the existing text projection used by result suppression. */
export function canonicalResultText(content: unknown): string {
  return resultContentToText(content)
}

const canonicalResultFacts = new WeakMap<object, { content: unknown; text: string; version?: number }>()

function textForCanonicalResult(result: NonNullable<ActiveSubagent['result']>): string {
  const cached = canonicalResultFacts.get(result)
  if (cached && cached.content === result.content) return cached.text
  const text = canonicalResultText(result.content)
  canonicalResultFacts.set(result, { content: result.content, text })
  return text
}

function versionForCanonicalResult(result: NonNullable<ActiveSubagent['result']>): number {
  const cached = canonicalResultFacts.get(result)!
  if (cached.version !== undefined) return cached.version
  cached.version = taskResultVersionForText(cached.text)
  return cached.version
}

/** A completed task may replace an earlier error with its successful result;
 *  non-text-only blocks stay canonical in the transcript instead of hiding
 *  the task's paged text. */
export function hasRicherCanonicalResult(
  task: TaskRecordUi | undefined,
  indexed: ActiveSubagent | undefined,
): boolean {
  const result = indexed?.result
  if (!result) return false
  const text = textForCanonicalResult(result)
  if (text.trim().length === 0) return false
  if (indexed.resultOrigin === 'summary' || indexed.resultOrigin === 'async_metadata') return false
  const resultVersion = task?.resultRef?.resultVersion
  if (resultVersion !== undefined && text.length === task?.resultRef?.totalChars &&
    versionForCanonicalResult(result) === resultVersion) {
    return task?.status !== 'completed' || !result.isError
  }
  if (!indexed.endedAtEstimated && indexed.endedAt != null && task?.endedAt != null && task.endedAt > indexed.endedAt) return false
  if (!indexed.endedAtEstimated && indexed.endedAt != null && task?.endedAt != null && task.endedAt < indexed.endedAt) return true
  if (indexed.resultOrigin === 'notification' && resultVersion !== undefined) return false
  return task?.status !== 'completed' || !result.isError
}
