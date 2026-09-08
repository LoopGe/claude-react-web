// Lightweight inline markers for mode-transition tool calls (EnterPlanMode,
// EnterWorktree, ExitWorktree). These are signal-only tool_use blocks with
// empty or minimal input — not actionable calls with rich content — so they
// render as thin divider-style cues instead of full ToolCard chrome.
//
// Extracted from ToolUseBlock.tsx for modularity.

import { IconClipboardList, IconGitBranch } from '../icons/ToolIcons'

// ---------------------------------------------------------------------------
// EnterPlanMode
// ---------------------------------------------------------------------------

/**
 * Lightweight inline marker for the EnterPlanMode tool. The model emits this
 * when it is about to start planning — the input is empty and there is nothing
 * to approve, so this is intentionally NOT a card with a body or status badge.
 * It reads as a thin divider-style cue ("Entered plan mode") so the transcript
 * shows the mode transition without the noise of an empty Plan proposal card.
 */
export function EnterPlanModeMarker() {
  return (
    <div className="enter-plan-marker" role="note" aria-label="Claude entered plan mode">
      <span className="enter-plan-marker-icon" aria-hidden>
        <IconClipboardList size={13} />
      </span>
      <span className="enter-plan-marker-label">Entered plan mode</span>
      <span className="enter-plan-marker-sub">Claude is planning before acting</span>
    </div>
  )
}

/** Lightweight inline marker for EnterWorktree / ExitWorktree. Like
 *  EnterPlanModeMarker these are mode-transition signals, not actionable tool
 *  calls with rich input — a full tool card would be noise.
 *
 *  EnterWorktree: shows the worktree name (new) or path basename (switch).
 *  ExitWorktree: shows the action (kept on disk / removed). */
export function WorktreeMarker({ input, action }: { input?: Record<string, unknown>; action: 'enter' | 'exit' }) {
  if (action === 'enter') {
    const name = typeof input?.name === 'string' ? input.name : null
    const path = typeof input?.path === 'string' ? input.path : null
    const label = path && !name ? 'Switched to worktree' : 'Entered worktree'
    const detail = name ?? (path ? path.split(/[/\\]/).filter(Boolean).pop() : null)
    return (
      <div className="worktree-marker" role="note" aria-label={label}>
        <span className="worktree-marker-icon" aria-hidden>
          <IconGitBranch size={13} />
        </span>
        <span className="worktree-marker-label">{label}</span>
        {detail && (
          <span className="worktree-marker-sub">
            <code>{detail}</code>
          </span>
        )}
      </div>
    )
  }
  // exit
  const act =
    input?.action === 'remove' ? 'removed'
    : input?.action === 'keep' ? 'kept on disk'
    : 'exited'
  return (
    <div className="worktree-marker" role="note" aria-label="Exited worktree">
      <span className="worktree-marker-icon" aria-hidden>
        <IconGitBranch size={13} />
      </span>
      <span className="worktree-marker-label">Exited worktree</span>
      <span className="worktree-marker-sub">{act}</span>
    </div>
  )
}
