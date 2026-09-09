import { useMemo } from 'react'
import type { ActiveSubagent, TranscriptItem } from '../../session-store/types'
import {
  sdkEchoedSubagentPrompt,
  subagentPromptItem,
  subagentResultItem,
  subagentResultText,
} from './transcript-rows'

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
 *  - the `ActiveSubagent` record — re-cloned by the reducer on nearly every
 *    pass (`{...sub, toolCount}`, status sweeps, TASKS_SNAPSHOT enrichment) —
 *    collapses to the result TEXT plus a timestamp.
 *
 * Both memos then hold their identity for as long as the answer is unchanged.
 */
export function useSubagentSyntheticRows(
  toolUseId: string | null | undefined,
  record: ActiveSubagent | undefined,
  items: readonly TranscriptItem[],
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

  const resultText = useMemo(() => subagentResultText(record), [record])
  const resultReceivedAt = record?.endedAt ?? record?.startedAt

  const trailingItems = useMemo(
    () =>
      toolUseId && resultText && resultText.trim()
        ? [subagentResultItem(toolUseId, resultText, resultReceivedAt)]
        : undefined,
    [toolUseId, resultText, resultReceivedAt],
  )

  return useMemo(() => ({ leadingItems, trailingItems }), [leadingItems, trailingItems])
}
