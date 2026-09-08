// Skill invocation tool_use view.
//
// Extracted from ToolUseBlock.tsx for modularity.

import { ToolCard } from '../ToolCard'
import { IconSparkles } from '../icons/ToolIcons'
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
 */
export function SkillToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const raw =
    typeof input.skill === 'string' ? input.skill
    : typeof input.name === 'string' ? input.name
    : null
  if (!raw) return <div className="tool-input">{formatJson(input)}</div>
  const args = typeof input.args === 'string' ? input.args.trim() : ''

  const colon = raw.indexOf(':')
  const namespace = colon > 0 ? raw.slice(0, colon) : ''
  const skillName = colon > 0 ? raw.slice(colon + 1) : raw

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
    </ToolCard>
  )
}
