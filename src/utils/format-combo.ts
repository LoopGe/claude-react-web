/** Pretty-print a combo string: "mod+shift+e" → "⌘⇧E" / "Ctrl+Shift+E". */
export function formatCombo(combo: string): string {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)
  const parts = combo.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1)
  if (isMac) {
    const macMods = mods.map((m) => {
      if (m === 'mod') return '⌘'
      if (m === 'alt') return '⌥'
      if (m === 'shift') return '⇧'
      return m
    })
    return [...macMods, key.toUpperCase()].join('')
  }
  const winMods = mods.map((m) => {
    if (m === 'mod') return 'Ctrl'
    if (m === 'alt') return 'Alt'
    if (m === 'shift') return 'Shift'
    return m
  })
  return [...winMods, key.length === 1 ? key.toUpperCase() : key].join('+')
}
