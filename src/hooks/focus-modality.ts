// Marks only the current pointer event task. A label can focus an input without
// sending pointerdown through that input, while compatibility focus can arrive
// after pointerup. The marker expires before later script/AT focus and never
// participates in hover retention after the focus event itself.

let pointerTask = false
let resetTimer: number | null = null

function reset(): void {
  if (resetTimer !== null) window.clearTimeout(resetTimer)
  resetTimer = null
  pointerTask = false
}

function onPointerEvent(): void {
  pointerTask = true
  if (resetTimer !== null) window.clearTimeout(resetTimer)
  resetTimer = window.setTimeout(() => {
    resetTimer = null
    pointerTask = false
  }, 0)
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', onPointerEvent, true)
  window.addEventListener('pointerup', onPointerEvent, true)
  window.addEventListener('pointercancel', onPointerEvent, true)
  window.addEventListener('keydown', reset, true)
}

export function isPointerFocusTask(): boolean {
  return pointerTask
}

export function __resetFocusModalityForTests(): void {
  reset()
}
