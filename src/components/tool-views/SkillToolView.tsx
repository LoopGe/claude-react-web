// Skill invocation tool_use view.
//
// Extracted from ToolUseBlock.tsx for modularity.

import { ToolCard } from '../ToolCard'
import { ElapsedTimer } from '../ElapsedTimer'
import { IconChevronRight, IconExternalLink, IconSparkles } from '../icons/ToolIcons'
import { useSkillContext } from '../../hooks/useSkillContext'
import { SUBAGENT_TOOL_NAMES } from '../../constants/toolNames'
import { splitSkillName } from '../../session-store/normalize'
import { formatJson } from '../../utils/format'
import { truncate } from '../../utils/text'
import type { ToolViewProps } from './shared'

/**
 * Skill invocation. Input shape (loosely typed — the SDK schema drifts, so
 * every field is validated before use):
 *   { skill: string, args?: string }
 *
 * The skill name is namespaced like `superpowers:subagent-driven-development`
 * (plugin/scope prefix + bare skill name). We split the prefix into a muted
 * accent chip and show the bare skill name as the title so the active
 * capability is scannable at a glance, with optional args rendered as a
 * muted body line — mirroring the WebFetch prompt layout so "tool + argument"
 * reads consistently across cards.
 *
 * FORKED skills get one extra row. Most Skill calls only load SKILL.md into the
 * current conversation and there is nothing behind the card; but the CLI can
 * also run a skill as its own agent and return just a final report, in which
 * case the fork's entire inner conversation reaches us as frames parented to
 * this tool_use id (see SKILL_TOOL_NAME). The main transcript renders root
 * frames only, so without the drill-in below that work — including any subagent
 * the fork launched — is invisible and unreachable. The row appears only when
 * such a sidechain actually exists, so the ordinary case is untouched.
 */
export function SkillToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  // Hook first — the early returns below are conditional, hooks can't be.
  const ctx = useSkillContext()
  const record = toolUseId ? ctx?.index.get(toolUseId) : undefined

  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  // The record is authoritative when present (same parse, done once in the
  // reducer); the input parse is the fallback for surfaces rendered without a
  // provider — exports, tests, and the frame that arrives before its record.
  const raw =
    record?.rawName ??
    (typeof input.skill === 'string' ? input.skill
    : typeof input.name === 'string' ? input.name
    : null)
  if (!raw) return <div className="tool-input">{formatJson(input)}</div>
  const args = record?.args ?? (typeof input.args === 'string' ? input.args.trim() : '')

  const { namespace, name: skillName } = splitSkillName(raw)

  const childCalls = record?.childCalls ?? []
  const forked = childCalls.length > 0
  const agentCount = childCalls.filter((c) => SUBAGENT_TOOL_NAMES.has(c.toolName)).length
  const isRunning = record?.status === 'running'

  const chips = namespace ? (
    <span className="tool-chip tool-chip-accent" title="Skill namespace">{namespace}</span>
  ) : null

  return (
    <ToolCard
      icon={<IconSparkles />}
      title={<code className="skill-tool-name">{skillName || raw}</code>}
      chips={chips}
      toolUseId={toolUseId}
      copyValue={() => raw}
      copyLabel="Copy skill name"
      className="tool-card-skill"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      {args && (
        <div className="skill-tool-args">
          <span className="skill-tool-args-marker" aria-hidden>└─</span>
          <span>{truncate(args, 400)}</span>
        </div>
      )}
      {forked && toolUseId && (
        <button
          type="button"
          className="skill-tool-fork"
          onClick={() => ctx?.open(toolUseId)}
          disabled={!ctx}
          title={`Open the forked execution — ${skillName || raw}`}
        >
          <span className="skill-tool-fork-marker" aria-hidden><IconChevronRight size={12} /></span>
          <span className="skill-tool-fork-label">forked execution</span>
          <span className="skill-tool-fork-meta">
            {childCalls.length} call{childCalls.length === 1 ? '' : 's'}
            {agentCount > 0 && ` · ${agentCount} agent${agentCount === 1 ? '' : 's'}`}
          </span>
          <ElapsedTimer
            startedAt={record?.startedAt}
            endedAt={record?.endedAt}
            live={isRunning}
            className="skill-tool-fork-elapsed"
          />
          <span className="skill-tool-fork-open" aria-hidden><IconExternalLink size={12} /></span>
        </button>
      )}
    </ToolCard>
  )
}
