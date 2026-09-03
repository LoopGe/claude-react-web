// Accessible right-aligned on/off switch. Used as the boolean control in
// settings rows (Server tab, MCP cards, Logs, App Plugins config). The
// visible label lives next to the switch in the caller's layout; `label` is
// the accessible name only, so a bare switch still announces what it toggles.

export function Switch({ checked, onChange, label }: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`settings-switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-switch-thumb" />
    </button>
  )
}
