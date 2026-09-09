// Collapsible container for a folded run of tool-only assistant rows
// (see ./transcript-rows.ts foldToolGroupRows).
//
// Settled groups collapse to a one-line header; a running tool or pending
// Plan/Question keeps the group open. Search force-expands only when the
// group's own name/input may match (tool results force-expand themselves
// via ToolResultDetails). Children are existing BlockView / ToolUseBlock
// cards — no tool view is rewritten.
//
// Collapsed header still surfaces running / waiting / failed so a failure
// or blocked turn is never hidden.

import { memo, useMemo, useState } from 'react'
import { BlockView } from './blocks'
import { usePlanStatusMap, useToolStatuses } from '../../hooks/usePlanStatus'
import { useQuestionAnswersMap } from '../../hooks/useQuestionAnswers'
import { groupMayMatchSearch, summarizeToolGroup } from './tool-grouping'
import { extractToolUseId, getBlocks } from '../../session-store/normalize'
import {
  IconAlertCircle,
  IconChevronDown,
  IconChevronRight,
  IconLayers,
  IconLoader,
  IconMessageQuestion,
} from '../icons/ToolIcons'
import type { SdkMessage } from '../../types'

export const ToolGroupCard = memo(function ToolGroupCard({
  members,
  memberItemIndices,
  activeMemberItemIndex,
  activeMatchInItem,
  searchQuery,
}: {
  members: SdkMessage[]
  memberItemIndices: number[]
  activeMemberItemIndex?: number
  activeMatchInItem?: number
  searchQuery?: string
}) {
  const toolStatuses = useToolStatuses()
  const planStatuses = usePlanStatusMap()
  const questionAnswers = useQuestionAnswersMap()

  const toolBlocks = useMemo(
    () =>
      members.flatMap((m) =>
        getBlocks(m).filter((b) => b.type === 'tool_use'),
      ),
    [members],
  )

  const summary = useMemo(
    () => summarizeToolGroup(toolBlocks, toolStatuses, planStatuses, questionAnswers),
    [toolBlocks, toolStatuses, planStatuses, questionAnswers],
  )

  const hasSearchHit = useMemo(
    () => groupMayMatchSearch(toolBlocks, searchQuery),
    [toolBlocks, searchQuery],
  )
  const autoOpen = summary.anyRunning || summary.anyPendingInteractive
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = hasSearchHit || (userOpen ?? autoOpen)

  const badge = summary.anyRunning ? (
    <span className="tool-status tool-status-running" title="A tool in this group is still running.">
      <IconLoader size={12} />
      <span className="tool-status-label">running</span>
    </span>
  ) : summary.anyPendingInteractive ? (
    <span
      className="tool-status tool-status-running"
      title="Waiting on you — a plan or question in this group needs a decision."
    >
      <IconMessageQuestion size={12} />
      <span className="tool-status-label">waiting</span>
    </span>
  ) : summary.anyError ? (
    <span className="tool-status tool-status-error" title="A tool in this group failed.">
      <IconAlertCircle size={12} />
      <span className="tool-status-label">failed</span>
    </span>
  ) : null

  return (
    <div
      className={
        'tool-group-card' +
        (summary.anyError ? ' tool-group-has-error' : '') +
        (summary.anyPendingInteractive && !summary.anyRunning ? ' tool-group-has-pending' : '')
      }
      data-state={open ? 'open' : 'closed'}
    >
      <div
        className="tool-group-summary-inner"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setUserOpen(!open)
          }
        }}
      >
        <span className="tool-group-chevron" aria-hidden>
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </span>
        <span className="tool-group-icon" aria-hidden>
          <IconLayers size={13} />
        </span>
        <span className="tool-group-count">{summary.count} tools</span>
        <span className="tool-group-names" title={summary.nameSummary}>
          {summary.nameSummary}
        </span>
        <span className="tool-card-spacer" />
        {badge}
      </div>
      {/* Keep children mounted when collapsed so nested ToolCard / PlanCard
          / permission state survives a fold (hidden, not unmounted). */}
      <div className="tool-group-body" hidden={!open}>
        {members.map((m, mi) => {
          const isActive =
            activeMemberItemIndex != null && memberItemIndices[mi] === activeMemberItemIndex
          return getBlocks(m)
            .filter((b) => b.type === 'tool_use')
            .map((b, bi) => (
              <BlockView
                key={extractToolUseId(b) ?? `${mi}-${bi}`}
                block={b}
                searchQuery={searchQuery}
                activeMatchIdx={isActive ? activeMatchInItem : undefined}
                toolResultActiveMatchIdx={isActive ? activeMatchInItem : undefined}
              />
            ))
        })}
      </div>
    </div>
  )
})
