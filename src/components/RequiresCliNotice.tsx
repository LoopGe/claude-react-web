// Locked-feature notice for capability-gated settings surfaces. A surface
// whose provider lacks the feature is SHOWN but disabled, and this note
// explains why. Text only — the optional-install upgrade path is a later
// packaging block; there is deliberately no button here.
//
// `className` is a placement escape hatch for consumers that need extra
// spacing/context (the settings groups and the create-dialog picker).

export function RequiresCliNotice({ className }: { className?: string }) {
  return (
    <div
      role="note"
      className={className ? `requires-cli-notice ${className}` : 'requires-cli-notice'}
    >
      This feature requires the Claude CLI.
    </div>
  )
}