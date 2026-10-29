// Shared skill preview modal: shows one skill's SKILL.md (frontmatter table +
// markdown body). Extracted from the global Settings → Skills tab so the
// session Settings → Loaded skills rows can open the exact same preview.

import { useMemo } from 'react'
import type { SkillRecord } from '../../../shared/skills'
import { parseSkillContent } from '../../utils/skill-frontmatter'
import { usePresenceValue } from '../../hooks/useExitPresence'
import { Overlay } from '../Overlay'
import { Markdown } from '../Markdown'
import { IconX } from '../icons/ToolIcons'

export function SkillPreviewModal({
  skill,
  onClose,
}: {
  skill: SkillRecord | null
  onClose: () => void
}) {
  // Keep the record alive during the exit animation so the modal can render
  // its content while the CSS outro plays.
  const presence = usePresenceValue(skill)
  const ps = presence.value

  const previewContent = ps?.content
  const parsed = useMemo(
    () => (previewContent ? parseSkillContent(previewContent) : null),
    [previewContent],
  )
  const hasFields = parsed ? Object.keys(parsed.frontmatter).length > 0 : false

  if (ps == null) return null
  return (
    <Overlay
      variant="modal"
      cardClassName="settings-skill-preview-modal"
      ariaLabel={`Skill preview: ${ps.name}`}
      open={skill !== null}
      onClose={onClose}
    >
      <div className="modal-header">
        <div className="settings-skill-preview-title">
          <span className="settings-card-name">{ps.name}</span>
          <span className="settings-card-badge">{ps.scope}</span>
          {!ps.valid && <span className="settings-card-badge warn">invalid</span>}
        </div>
        <button className="btn-icon" aria-label="Close" onClick={onClose}>
          <IconX size={14} />
        </button>
      </div>
      <div className="settings-card-path">{ps.path}</div>
      {ps.errors.length > 0 && (
        <div className="settings-error">{ps.errors.join('; ')}</div>
      )}
      {hasFields && (
        <div className="settings-skill-frontmatter">
          <div className="settings-skill-frontmatter-title">Frontmatter</div>
          <table className="settings-skill-frontmatter-table">
            <tbody>
              {Object.entries(parsed!.frontmatter).map(([key, value]) => (
                <tr key={key}>
                  <td className="settings-skill-fm-key">{key}</td>
                  <td className="settings-skill-fm-value">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {parsed ? (
        <div className="settings-skill-preview-content">
          <Markdown text={parsed.body} />
        </div>
      ) : (
        <pre className="settings-skill-preview-content settings-skill-preview-raw">
          {ps.content || ''}
        </pre>
      )}
    </Overlay>
  )
}
