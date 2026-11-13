import { useCallback, useMemo, useState } from 'react'
import { IconArrowLeft } from './icons/ToolIcons'
import { MessageList } from './MessageList'
import { SubagentProvider } from '../hooks/useSubagentContext'
import { WorkflowProvider } from '../hooks/useWorkflowContext'
import { SkillProvider, skillRecordAsSubagent } from '../hooks/useSkillContext'
import { toTranscriptItem, getBlocks, extractToolUseId } from '../session-store/normalize'
import { countMatches } from '../search/match'
import { extractMessageSearchSegments } from '../search'
import { countMessageSearchMatches } from '../../shared/search/segments'
import { createInitialServerMirror } from '../session-store/types'
import { updateIndexesMirror, drainPendingResults } from '../session-store/index-pipeline'
import { useMessagePreview, type MessagePreviewTarget } from '../hooks/useMessagePreview'
import type { TranscriptItem } from '../session-store/types'

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
  return role === 'user' ? 'You' : role === 'tool_result' ? 'Tool' : 'Claude'
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
    let prev: TranscriptItem | undefined
    for (const message of preview.page.messages) {
      const item = toTranscriptItem(message.msg, prev)
      if (item) {
        out.push(item)
        prev = item
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
    if (index < 0) return { index: -1, resultId: undefined as string | undefined }
    const resultBlocks = getBlocks(items[index].msg).filter((block) => block.type === 'tool_result')
    const ownerId = target.kind === 'hit' ? target.hit.ownerToolUseId : undefined
    const matchedBlock = resultBlocks.find((block) => {
      const content = (block as { content?: unknown }).content
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? (content as Array<{ type?: string; text?: string }>)
                .filter((part) => part.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text)
                .join('\n\n')
            : ''
      return countMatches(text, target.query) > 0
    }) as { tool_use_id?: string } | undefined
    const resultId =
      matchedBlock?.tool_use_id ??
      (ownerId && resultBlocks.some((block) => (block as { tool_use_id?: string }).tool_use_id === ownerId)
        ? ownerId
        : (resultBlocks[0] as { tool_use_id?: string } | undefined)?.tool_use_id)
    return { index, resultId }
  }, [items, preview.page, target])

  // Replay the same index pipelines the live reducer runs: generic tool
  // statuses, merged results, plan/question lifecycle, and the sidechain
  // (Agent / Workflow / forked Skill) records. MessageList expects these maps;
  // a page fetched around an old hit is not present in the live store.
  const lifecycles = useMemo(() => {
    let base = createInitialServerMirror()
    for (const item of items) base = updateIndexesMirror(base, item.msg)
    base = drainPendingResults(base)

    // The hit must stay highlightable. If it is a tool_result, keep that
    // result standalone only in the main preview. The detail view retains the
    // reducer-selected canonical result instead of reconstructing it with a
    // second set of precedence rules.
    const resultId = targetInfo.resultId
    if (!resultId) return { base, transcript: base }
    const toolResults = new Map(base.toolResults)
    toolResults.delete(resultId)
    const activeSubagents = new Map(base.activeSubagents)
    const subagent = activeSubagents.get(resultId)
    if (subagent) {
      activeSubagents.set(resultId, {
        ...subagent,
        // background/pending/dismissed records consume their ack even without
        // a captured result. Marking the record settled-and-result-less is
        // what keeps that ack visible as the matched bubble.
        status:
          subagent.status === 'background' || subagent.status === 'pending' || subagent.status === 'dismissed'
            ? 'done'
            : subagent.status,
        result: undefined,
        resultOrigin: undefined,
      })
    }
    const activeWorkflows = new Map(base.activeWorkflows)
    const workflow = activeWorkflows.get(resultId)
    if (workflow?.result) activeWorkflows.set(resultId, { ...workflow, result: undefined })
    const activeSkills = new Map(base.activeSkills)
    const skill = activeSkills.get(resultId)
    if (skill?.result) activeSkills.set(resultId, { ...skill, result: undefined })
    return {
      base,
      transcript: { ...base, toolResults, activeSubagents, activeWorkflows, activeSkills },
    }
  }, [items, targetInfo.resultId])
  const lifecycle = lifecycles.transcript
  const detailLifecycle = lifecycles.base
  const contentLifecycle = sidechainId && targetInfo.resultId && targetInfo.resultId !== sidechainId
    ? lifecycle
    : sidechainId
      ? detailLifecycle
      : lifecycle

  const messages = useMemo(() => items.map((item) => item.msg), [items])

  const targetItemIndex = useMemo(() => {
    const resultId = targetInfo.resultId
    if (!resultId) return targetInfo.index
    // Plan/question results stay merged into their cards: rewriting their
    // lifecycle would falsify the snapshot. Seek the owning card instead of
    // the consumed result row.
    if (lifecycle.planStatus.has(resultId) || lifecycle.questionAnswers.has(resultId)) {
      const owner = items.findIndex((candidate) =>
        getBlocks(candidate.msg).some(
          (block) => block.type === 'tool_use' && extractToolUseId(block) === resultId,
        ),
      )
      return owner >= 0 ? owner : targetInfo.index
    }
    return targetInfo.index
  }, [items, lifecycle, targetInfo])

  const title = target.kind === 'hit' ? `Turn ${target.hit.turnNo}` : 'Message'
  const subtitle = target.kind === 'hit' ? target.hit.turnPrompt : ''
  const meta =
    target.kind === 'hit'
      ? [roleLabel(target.hit.role), formatTime(target.hit.timestamp)].filter(Boolean).join(' · ')
      : 'From the command palette'

  const targetMatchOrdinal = target.kind === 'hit'
    ? target.hit.matchOrdinal ?? 0
    : target.messageMatchOrdinal ?? target.matchOrdinal ?? 0

  const transcript = (
    <MessageList
      key={target.kind === 'hit' ? `hit:${target.hit.messageSeq}` : `uuid:${target.uuid}`}
      static
      items={items}
      sessionId={sessionId}
      cwd={cwd}
      toolStatus={contentLifecycle.toolStatus}
      toolResults={contentLifecycle.toolResults}
      planStatus={contentLifecycle.planStatus}
      planContent={contentLifecycle.planContent}
      questionAnswers={contentLifecycle.questionAnswers}
      toolGroupCards={toolGroupCards}
      autoExpandRunningGroups={autoExpandRunningGroups}
      showMessageHeaders={showMessageHeaders}
      searchQuery={target.query}
      searchActiveMsgIdx={targetItemIndex >= 0 ? targetItemIndex : undefined}
      searchActiveMatchInItem={targetItemIndex >= 0 ? targetMatchOrdinal : undefined}
      replayReady
    />
  )

  const sidechainRecord = sidechainId
    ? (detailLifecycle.activeSubagents.get(sidechainId) ??
      detailLifecycle.activeWorkflows.get(sidechainId) ??
      detailLifecycle.activeSkills.get(sidechainId))
    : undefined
  const sidechainLabel =
    (sidechainRecord as { label?: string; name?: string } | undefined)?.label ??
    (sidechainRecord as { name?: string } | undefined)?.name ??
    'Sidechain'

  const sidechainSkill = sidechainId ? detailLifecycle.activeSkills.get(sidechainId) : undefined
  const sidechainSubagent = sidechainId
    ? (detailLifecycle.activeSubagents.get(sidechainId) ??
      (sidechainSkill ? skillRecordAsSubagent(sidechainSkill) : undefined))
    : undefined

  const sidechainTargetItemIndex = sidechainId && targetInfo.resultId === sidechainId
    ? (() => {
        const sourceIndex = items.findIndex((item) =>
          item.msg.parent_tool_use_id === sidechainId && item.msg.type === 'assistant' &&
          countMessageSearchMatches(extractMessageSearchSegments(item.msg), target.query) > 0,
        )
        return sourceIndex >= 0 ? sourceIndex : -1000
      })()
    : targetItemIndex

  const content = sidechainId ? (
    <MessageList
      key={`sidechain:${sidechainId}`}
      static
      items={items}
      parentToolUseIdFilter={sidechainId}
      subagent={sidechainSubagent}
      sessionId={sessionId}
      cwd={cwd}
      toolStatus={contentLifecycle.toolStatus}
      toolResults={contentLifecycle.toolResults}
      planStatus={contentLifecycle.planStatus}
      planContent={contentLifecycle.planContent}
      questionAnswers={contentLifecycle.questionAnswers}
      toolGroupCards={toolGroupCards}
      autoExpandRunningGroups={autoExpandRunningGroups}
      showMessageHeaders={showMessageHeaders}
      searchQuery={target.query}
      searchActiveMsgIdx={sidechainTargetItemIndex}
      searchActiveMatchInItem={sidechainTargetItemIndex >= 0 || sidechainTargetItemIndex === -1000 ? targetMatchOrdinal : undefined}
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
            value={{ index: contentLifecycle.activeSubagents, messages, open: openSidechain }}
          >
            <WorkflowProvider value={{ index: contentLifecycle.activeWorkflows, open: openSidechain }}>
              <SkillProvider value={{ index: contentLifecycle.activeSkills, open: openSidechain }}>
                {content}
              </SkillProvider>
            </WorkflowProvider>
          </SubagentProvider>
        )}
      </div>
    </section>
  )
}