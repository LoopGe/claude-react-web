import {
  MOTION_DURATION_TOKENS,
  resolveMotionDurationMs,
  type AnimationSpeedPreset,
} from '../../shared/animation-speed'

/** Apply an Animation speed preset to the document: write the final scaled
 *  `NNNms` onto every `--motion-duration-*` token (inline on <html>, because
 *  two JS consumers parse the computed value numerically) and mirror the Off
 *  preset as `data-motion="off"` for the stylesheet's hardcoded-animation
 *  suppressors.
 *
 *  Single writer for this document state — App calls it from one effect.
 *  Standard = scale 1, i.e. the shipped tokens. */
export function applyAnimationSpeedToDocument(preset: AnimationSpeedPreset): void {
  const root = document.documentElement
  if (preset === 'off') root.dataset.motion = 'off'
  else delete root.dataset.motion

  for (const { token, baseMs } of MOTION_DURATION_TOKENS) {
    root.style.setProperty(token, `${resolveMotionDurationMs(baseMs, preset)}ms`)
  }
}
