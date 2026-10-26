// Keyboard-selection vocabulary for the git panel. Kept out of GitPanel.tsx
// so the pure predicate is importable (and testable) without dragging the
// panel's whole component/markdown import chain along — and so the component
// file exports only components (react-refresh/only-export-components).

/** What a keyboard-selection row is. `commit-file` is a file row from an
 *  expanded commit's file list (read-only history); the rest are worktree
 *  rows the panel can mutate. */
export type GitSelectableKind = 'unstaged' | 'staged' | 'untracked' | 'commit-file'

/** Whether the s/u/x write keys are inert for a keyboard-selection kind.
 *  A commit's file rows are read-only history — stage/unstage/discard must
 *  never fire against them — so those keys bail before preventDefault or
 *  any write op. */
export function isWriteKeyInert(kind: GitSelectableKind): boolean {
  return kind === 'commit-file'
}
