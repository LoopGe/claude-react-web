import { useCallback, useMemo, useState } from 'react'
import { IconArrowLeft } from './icons/ToolIcons'
import { MessageList } from './MessageList'
import { SubagentProvider } from '../hooks/useSubagentContext'
import { WorkflowProvider } from '../hooks/useWorkflowContext'
import { SkillProvider, skillRecordAsSubagent } from '../hooks/useSkillContext'
import { toTranscriptItem, getBlocks, extractToolUseId } from '../session-store/normalize'
import { resultHitMemberOrdinal } from './message-list/search-addressing'
import { countMatches } from '../search/match'
import { extractMessageSearchSegments } from '../search'
import { countMessageSearchMatches } from '../../shared/search/segments'
import { toolResultTextRuns } from '../../shared/tool-result-text'
import { createInitialServerMirror } from '../session-store/types'
import { updateIndexesMirror, drainPendingResults } from '../session-store/index-pipeline'
import { useMessagePreview, type MessagePreviewTarget } from '../hooks/useMessagePreview'
import type { TranscriptItem } from '../session-store/types'
import type { SdkMessage } from '../types'

interface Props {
  sessionId: string
  target: MessagePreviewTarget
  onBack: () => void
  /** Session prefs, resolved by Chat like the main transcript. */
  toolGroupCards?: boolean
  showMessageHeaders?: boolean
  autoExpandRunningGroups?: boolean
  /** Session cwd, used by resource/file links inside messages. */
  cwd?: string
}

function roleLabel(role: string): string {
  return role === 'user' ? 'You' : role === 'tool_result' ? 'Tool' : 'Agent'
}

function formatTime(timestamp?: number): string {
  if (timestamp == null) return ''
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Read-only snapshot of the messages around a search hit. It owns its own
 * fetch and never touches the live transcript store, so the chat behind the
 * panel keeps following the tail.
 *
 * Rendering is the real MessageList in static mode: same rows, tool groups,
 * preferences and search highlighting as the main transcript.
 */
export function SessionSearchPreview({
  sessionId,
  target,
  onBack,
  toolGroupCards = true,
  showMessageHeaders = true,
  autoExpandRunningGroups = true,
  cwd,
}: Props) {
  const preview = useMessagePreview(sessionId, target)
  const [sidechainStack, setSidechainStack] = useState<string[]>([])
  const [lastTarget, setLastTarget] = useState(target)
  if (lastTarget !== target) {
    setLastTarget(target)
    setSidechainStack([])
  }
  const sidechainId = sidechainStack[sidechainStack.length - 1] ?? null
  const openSidechain = useCallback(
    (id: string) => setSidechainStack((prev) => (prev[prev.length - 1] === id ? prev : [...prev, id])),
    [],
  )
  const closeSidechain = useCallback(() => setSidechainStack((prev) => prev.slice(0, -1)), [])

  const items = useMemo<TranscriptItem[]>(() => {
    if (!preview.page) return []
    const out: TranscriptItem[] = []
    for (const message of preview.page.messages) {
      const item = toTranscriptItem(message.msg)
      if (item) {
        out.push(item)
      }
    }
    return out
  }, [preview.page])

  const targetInfo = useMemo(() => {
    // Match by message object, not by uuid: some transcript entries have no
    // uuid, and toTranscriptItem then generates a synthetic id. aroundSeq also
    // covers aroundUuid resolving an alias to a covering message.
    const aroundSeq = preview.page?.aroundSeq
    const centered =
      aroundSeq != null
        ? preview.page?.messages.find((m) => m.seq === aroundSeq)
        : target.kind === 'uuid'
          ? preview.page?.messages.find((m) => m.uuid === target.uuid)
          : preview.page?.messages.find((m) => m.seq === target.hit.messageSeq)
    const index = centered ? items.findIndex((item) => item.msg === centered.msg) : -1
    if (index < 0) return { index: -1, resultId: undefined as string | undefined, msg: undefined as SdkMessage | undefined }
    const resultBlocks = getBlocks(items[index].msg).filter((block) => block.type === 'tool_result')
    const ownerId = target.kind === 'hit' ? target.hit.ownerToolUseId : undefined
    // Existence probe only: selects WHICH result block carries the hit, via
    // the shared rendered-run view (the same text the card renders). It never
    // feeds ordinals — resultHitMemberOrdinal owns the ordinal conversion.
    const matchedBlock = resultBlocks.find((block) =>
      toolResultTextRuns((block as { content?: unknown }).content).some(
        (run) => countMatches(run, target.query) > 0,
      ),
    ) as { tool_use_id?: string } | undefined
    const resultId =
      matchedBlock?.tool_use_id ??
      (ownerId && resultBlocks.some((block) => (block as { tool_use_id?: string }).tool_use_id === ownerId)
        ? ownerId
        : (resultBlocks[0] as { tool_use_id?: string } | undefined)?.tool_use_id)
    return { index, resultId, msg: centered?.msg }
  }, [items, preview.page, target])

  // Replay the same index pipelines the live reducer runs: generic tool
  // statuses, merged results, plan/question lifecycle, and the sidechain
  // (Agent / Workflow / forked Skill) records. MessageList expects these maps;
  // a page fetched around an old hit is not present in the live store. The
  // hit's result stays merged exactly as the live transcript renders it —
  // both the main view and the sidechain detail read this one lifecycle.
  const lifecycle = useMemo(() => {
    let base = createInitialServerMirror()
    for (const item of items) base = updateIndexesMirror(base, item.msg)
    return drainPendingResults(base)
  }, [items])

  const messages = useMemo(() => items.map((item) => item.msg), [items])

  // The item carrying the tool_use block the hit's result settled (-1 when the
  // result is unconsumed or its owner is off-page). Consumed results stay merged
  // into their cards: rewriting their lifecycle would falsify the snapshot, so
  // the preview seeks the owning card row instead of the consumed result row,
  // which no longer renders on its own. Covers generic tool cards (toolResults),
  // plan/question cards, and the sidechain owners (Agent/Task/Explore via
  // activeSubagents, Workflow via activeWorkflows) — those ids never enter
  // toolResults (TOOL_STATUS_EXCLUDE); their results are consumed through the
  // sidechain records instead. Forked Skills are already covered via toolResults.
  const ownerItemIndex = useMemo(() => {
    const resultId = targetInfo.resultId
    if (!resultId) return -1
    if (
      !lifecycle.planStatus.has(resultId) &&
      !lifecycle.questionAnswers.has(resultId) &&
      !lifecycle.toolResults.has(resultId) &&
      !lifecycle.activeSubagents.has(resultId) &&
      !lifecycle.activeWorkflows.has(resultId)
    ) {
      return -1
    }
    return items.findIndex((candidate) =>
      getBlocks(candidate.msg).some(
        (block) => block.type === 'tool_use' && extractToolUseId(block) === resultId,
      ),
    )
  }, [items, lifecycle, targetInfo])

  const targetItemIndex = useMemo(() => {
    if (ownerItemIndex < 0) return targetInfo.index
    // Sidechain-owned hit: the root-only row model renders no child rows. Walk
    // parent_tool_use_id up to the ROOT ancestor item (the item whose tool_use
    // block id equals that parent; repeat until parent null) and seek THAT card
    // row. The active mark for a child hit lives in the sidechain view after
    // drill-in — the bespoke root card does not render the child's result text.
    let root = ownerItemIndex
    let parent = items[root].msg.parent_tool_use_id
    while (parent != null) {
      const next = items.findIndex((candidate) =>
        getBlocks(candidate.msg).some(
          (block) => block.type === 'tool_use' && extractToolUseId(block) === parent,
        ),
      )
      if (next < 0) break
      root = next
      parent = items[root].msg.parent_tool_use_id
    }
    return root
  }, [items, ownerItemIndex, targetInfo])

  const title = target.kind === 'hit' ? `Turn ${target.hit.turnNo}` : 'Message'
  const subtitle = target.kind === 'hit' ? target.hit.turnPrompt : ''
  const meta =
    target.kind === 'hit'
      ? [roleLabel(target.hit.role), formatTime(target.hit.timestamp)].filter(Boolean).join(' · ')
      : 'From the command palette'

  const targetMatchOrdinal = target.kind === 'hit'
    ? target.hit.matchOrdinal ?? 0
    : target.messageMatchOrdinal ?? target.matchOrdinal ?? 0

  // A result hit's server ordinal is message-local to the RESULT message (raw
  // runs); the owner card renders in segments-then-results member space. Convert
  // it once for both views. Non-result hits keep their message-local ordinal; a
  // failed conversion (owner off-page / out of range) yields undefined so no
  // misrouted raw ordinal ever lights a mark.
  const hitMemberOrdinal =
    target.kind === 'hit' && target.hit.ownerToolUseId && ownerItemIndex >= 0 && targetInfo.msg
      ? resultHitMemberOrdinal(
          items[ownerItemIndex].msg,
          lifecycle.toolResults,
          targetInfo.msg,
          target.hit.ownerToolUseId,
          targetMatchOrdinal,
          target.query,
        )
      : targetMatchOrdinal

  // A sidechain-owned hit lights no mark in the main (root-only) view: the child
  // result text is not rendered by the bespoke root card. Its mark lives in the
  // sidechain view after drill-in.
  const ownerIsSidechainChild =
    ownerItemIndex >= 0 && items[ownerItemIndex].msg.parent_tool_use_id != null
  const mainActiveOrdinal = ownerIsSidechainChild ? undefined : hitMemberOrdinal

  const transcript = (
    <MessageList
      key={target.kind === 'hit' ? `hit:${target.hit.messageSeq}` : `uuid:${target.uuid}`}
      static
      items={items}
      sessionId={sessionId}
      cwd={cwd}
      toolStatus={lifecycle.toolStatus}
      toolResults={lifecycle.toolResults}
      planStatus={lifecycle.planStatus}
      planContent={lifecycle.planContent}
      questionAnswers={lifecycle.questionAnswers}
      toolGroupCards={toolGroupCards}
      autoExpandRunningGroups={autoExpandRunningGroups}
      showMessageHeaders={showMessageHeaders}
      searchQuery={target.query}
      searchActiveMsgIdx={targetItemIndex >= 0 ? targetItemIndex : undefined}
      searchActiveMatchInItem={targetItemIndex >= 0 ? mainActiveOrdinal : undefined}
      replayReady
    />
  )

  const sidechainRecord = sidechainId
    ? (lifecycle.activeSubagents.get(sidechainId) ??
      lifecycle.activeWorkflows.get(sidechainId) ??
      lifecycle.activeSkills.get(sidechainId))
    : undefined
  const sidechainLabel =
    (sidechainRecord as { label?: string; name?: string } | undefined)?.label ??
    (sidechainRecord as { name?: string } | undefined)?.name ??
    'Sidechain'

  const sidechainSkill = sidechainId ? lifecycle.activeSkills.get(sidechainId) : undefined
  const sidechainSubagent = sidechainId
    ? (lifecycle.activeSubagents.get(sidechainId) ??
      (sidechainSkill ? skillRecordAsSubagent(sidechainSkill) : undefined))
    : undefined

  const sidechainTargetItemIndex = !sidechainId
    ? targetItemIndex
    : targetInfo.resultId === sidechainId
      ? (() => {
          const sourceIndex = items.findIndex((item) =>
            item.msg.parent_tool_use_id === sidechainId && item.msg.type === 'assistant' &&
            countMessageSearchMatches(extractMessageSearchSegments(item.msg), target.query) > 0,
          )
          return sourceIndex >= 0 ? sourceIndex : -1000
        })()
      : ownerItemIndex >= 0 && items[ownerItemIndex].msg.parent_tool_use_id === sidechainId
        ? ownerItemIndex
        : targetItemIndex

  // The sidechain's OWN result (resultId === sidechainId) renders through the
  // synthetic reply row, whose match space is the result's raw runs — the server
  // ordinal applies directly. Every other hit uses the converted member ordinal
  // (undefined when the conversion fails → no active mark, never a raw ordinal).
  const sidechainActiveOrdinal =
    sidechainId && targetInfo.resultId === sidechainId ? targetMatchOrdinal : hitMemberOrdinal

  const content = sidechainId ? (
    <MessageList
      key={`sidechain:${sidechainId}`}
      static
      items={items}
      parentToolUseIdFilter={sidechainId}
      subagent={sidechainSubagent}
      sessionId={sessionId}
      cwd={cwd}
      toolStatus={lifecycle.toolStatus}
      toolResults={lifecycle.toolResults}
      planStatus={lifecycle.planStatus}
      planContent={lifecycle.planContent}
      questionAnswers={lifecycle.questionAnswers}
      toolGroupCards={toolGroupCards}
      autoExpandRunningGroups={autoExpandRunningGroups}
      showMessageHeaders={showMessageHeaders}
      searchQuery={target.query}
      searchActiveMsgIdx={sidechainTargetItemIndex}
      searchActiveMatchInItem={sidechainTargetItemIndex >= 0 || sidechainTargetItemIndex === -1000 ? sidechainActiveOrdinal : undefined}
      replayReady
      emptyStateContent={
        <div className="search-preview-state">No sidechain messages in this page</div>
      }
    />
  ) : (
    transcript
  )

  return (
    <section className="search-preview" aria-label="Search result preview">
      <header className="search-preview-header">
        <button
          type="button"
          className="search-preview-back"
          aria-label={sidechainId ? 'Back to preview' : 'Back to results'}
          onClick={sidechainId ? closeSidechain : onBack}
        >
          <IconArrowLeft size={14} />
        </button>
        <div className="search-preview-heading">
          <span className="search-preview-title">{sidechainId ? sidechainLabel : title}</span>
          {sidechainId ? (
            <span className="search-preview-subtitle">Subagent conversation</span>
          ) : (
            subtitle && <span className="search-preview-subtitle">{subtitle}</span>
          )}
        </div>
        <span className="search-preview-meta">{meta}</span>
      </header>

      <div className="search-preview-body">
        {preview.loading ? (
          <div className="search-preview-state">Loading…</div>
        ) : preview.error === 'not-found' ? (
          <div className="search-preview-state">This message is no longer available</div>
        ) : preview.error === 'failed' ? (
          <div className="search-preview-state">
            Could not load this message{' '}
            <button type="button" className="search-preview-retry" onClick={preview.retry}>
              Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="search-preview-state">No messages to preview</div>
        ) : targetItemIndex < 0 ? (
          <div className="search-preview-state">This message is not shown in the transcript</div>
        ) : (
          <SubagentProvider
            value={{ index: lifecycle.activeSubagents, messages, open: openSidechain }}
          >
            <WorkflowProvider value={{ index: lifecycle.activeWorkflows, open: openSidechain }}>
              <SkillProvider value={{ index: lifecycle.activeSkills, open: openSidechain }}>
                {content}
              </SkillProvider>
            </WorkflowProvider>
          </SubagentProvider>
        )}
      </div>
    </section>
  )
}