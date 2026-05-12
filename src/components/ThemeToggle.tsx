// Toggle button for cycling through dark, light, and system themes.

import type { Theme } from '../utils/theme'

interface Props {
  theme: Theme
  onToggle: () => void
}

const LABELS: Record<Theme, { icon: string; next: Theme; title: string }> = {
  dark: { icon: '☀', next: 'light', title: 'Currently dark · click for light' },
  light: { icon: '🌙', next: 'system', title: 'Currently light · click for system' },
  system: { icon: '🖥', next: 'dark', title: 'Currently system · click for dark' },
}

export function ThemeToggle({ theme, onToggle }: Props) {
  const { icon, title } = LABELS[theme]
  return (
    <button
      className="btn btn-icon"
      onClick={onToggle}
      title={title}
      aria-label={`Toggle theme (${theme})`}
    >
      {icon}
    </button>
  )
}
