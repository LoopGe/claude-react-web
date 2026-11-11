import { useMemo } from 'react'
import type { ActiveSubagent, TranscriptItem } from '../../session-store/types'
import { getBlocks } from '../../session-store/normalize'
import {
  sdkEchoedSubagentPrompt,
  subagentPromptItem,
  subagentResultContent,
  subagentResultItem,
} from './transcript-rows'

const nonTextKeyCache = new WeakMap<object, string>()
function nonTextKey(block: unknown): string {
  if (block == null || typeof block !== 'object') return JSON.stringify(block) ?? ''
  const cached = nonTextKeyCache.get(block)
  if (cached != null) return cached
  const key = JSON.stringify(block) ?? ''
  nonTextKeyCache.set(block, key)
  return key
}

/**
 * Referential-stability wrapper around the subagent synthetic-row builders.
 *
 * The builders in `transcript-rows.ts` are pure, so calling them per render
 * would hand `buildTranscriptRows` a brand-new `msg` object on every message
 * flush. That breaks invariant I2 in two visible ways:
 *
 *  1. `advanceRowAnchor` identifies the front row by id — but `MessageView` is
 *     memoised on its props, so a fresh `msg` re-renders the prompt/result row
 *     (and everything it contains) on every flush anywhere in the session.
 *  2. Virtuoso re-measures a row whose subtree re-rendered. A row that keeps
 *     re-measuring while the user scrolls is exactly how offsets end up wrong.
 *
 * The fix is to narrow every dependency to a PRIMITIVE before it reaches the
 * memo that allocates the row:
 *
 *  - the whole `items` array collapses to a single boolean (has the SDK echoed
 *    the prompt yet?), so unrelated main-thread frames don't invalidate it;
 *  - results are projected against the visible sidechain: matching text stays
 *    in its original rows, supplemental blocks are appended, and a trimmed or
 *    out-of-page source falls back to the captured result;
 *  - the `ActiveSubagent` record — re-cloned by the reducer on nearly every
 *    pass (`{...sub, toolCount}`, status sweeps, TASKS_SNAPSHOT enrichment) —
 *    collapses to its stable result payload, flattened text and timestamp.
 *
 * Both memos then hold their identity for as long as the answer is unchanged.
 */
export function useSubagentSyntheticRows(
  toolUseId: string | null | undefined,
  record: ActiveSubagent | undefined,
  items: readonly TranscriptItem[],
  includeRootSidechain = false,
): { leadingItems?: TranscriptItem[]; trailingItems?: TranscriptItem[] } {
  const prompt = record?.prompt
  const startedAt = record?.startedAt
  // Only probe when there is a prompt to inject; the scan is O(items).
  const echoed = useMemo(
    () => (toolUseId && prompt ? sdkEchoedSubagentPrompt(items, toolUseId) : false),
    [toolUseId, prompt, items],
  )

  const leadingItems = useMemo(
    () =>
      toolUseId && prompt && !echoed
        ? [subagentPromptItem(toolUseId, prompt, startedAt)]
        : undefined,
    [toolUseId, prompt, startedAt, echoed],
  )

  const resultStatus = record?.status
  const resultOrigin = record?.resultOrigin
  const resultIsAsync = record?.isAsync
  const capturedResult = record?.result
  const hasResult = capturedResult != null && (
    resultStatus === 'done' || resultStatus === 'rejected' || resultStatus === 'interrupted' || resultStatus === 'dismissed'
  )
  const nonTextTypeKey = Array.isArray(capturedResult?.content)
    ? Array.from(new Set(capturedResult.content.filter((block) => block?.type !== 'text').map((block) => String(block?.type)))).sort().join(',')
    : ''
  const needsNonTextProjection = nonTextTypeKey.length > 0
  const sidechain = useMemo(() => {
    if (!toolUseId || !hasResult) return { text: '', nonTextKeys: '' }
    const text: string[] = []
    const nonTextKeys: string[] = []
    const nonTextTypes = new Set(nonTextTypeKey.split(','))
    for (const item of items) {
      const parentId = item.msg.parent_tool_use_id
      const isSidechain = parentId === toolUseId || (includeRootSidechain && parentId == null)
      if (!isSidechain || item.msg.type !== 'assistant') continue
      for (const block of getBlocks(item.msg)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (block.text.trim()) text.push(block.text.trim())
        } else if (needsNonTextProjection && nonTextTypes.has(String(block.type))) {
          nonTextKeys.push(nonTextKey(block))
        }
      }
    }
    return { text: text.join('\n\n').trim(), nonTextKeys: nonTextKeys.join('\0') }
  }, [items, toolUseId, hasResult, includeRootSidechain, needsNonTextProjection, nonTextTypeKey])
  const sidechainText = sidechain.text
  const sidechainNonTextKeys = sidechain.nonTextKeys
  const result = useMemo(() => subagentResultContent(
    resultStatus
      ? { status: resultStatus, resultOrigin, isAsync: resultIsAsync, result: capturedResult }
      : undefined,
    { text: sidechainText, nonTextKeys: sidechainNonTextKeys },
  ), [resultStatus, resultOrigin, resultIsAsync, capturedResult, sidechainText, sidechainNonTextKeys])
  const resultContent = result?.content
  const resultText = result?.text ?? ''
  const resultReceivedAt = record?.endedAt ?? record?.startedAt

  const trailingItems = useMemo(
    () =>
      toolUseId && resultContent != null
        ? [subagentResultItem(toolUseId, resultContent, resultText, resultReceivedAt)]
        : undefined,
    [toolUseId, resultContent, resultText, resultReceivedAt],
  )

  return useMemo(() => ({ leadingItems, trailingItems }), [leadingItems, trailingItems])
}
