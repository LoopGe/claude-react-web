// Wizard step table — the single source of truth for the setup wizard.
//
// Lives in its own module rather than inside SetupPage.tsx so the host-shape
// drift-guard tests can import STEPS directly without tripping the
// react-refresh/only-export-components rule (a component file may only
// export components).
//
// Adding a step is a one-element edit in STEPS — the Step union, TOTAL_STEPS,
// the progress map, and the subtitle/short-name lookups all derive from it.
//
// Step 0 (Environment) is the CLI-binary check. We keep it at id 0 rather
// than reusing 1 so persisted ?step=N URLs (if we ever add them) keep their
// meaning. The progress dots / counters use array index, not id, so
// 0-indexing here doesn't leak into the UI labels.

import { isDesktopHost } from '../host-capabilities'

export const STEPS = [
  { id: 0, short: 'Environment', subtitle: 'Checking the local Claude CLI environment.' },
  { id: 1, short: 'Auth Token', subtitle: 'Configure your Anthropic API credentials to get started.' },
  { id: 2, short: 'Models', subtitle: 'Pick the models you want available in new sessions.' },
  { id: 3, short: 'MCP', subtitle: 'Import MCP servers from your Claude CLI config.' },
  { id: 4, short: 'Notifications', subtitle: 'Decide how you want to be notified when a turn completes.' },
  { id: 5, short: 'Updates', subtitle: 'Choose the npm registry used to check for updates.' },
  // Web host only — the desktop app has no TCP server to auto-start (Electron
  // login items are a separate future feature).
  ...(isDesktopHost()
    ? []
    : [{ id: 6, short: 'Autostart', subtitle: 'Run Claude Web automatically when you log in.' }]),
  { id: 7, short: 'Finish', subtitle: "You're ready — let's open your first session." },
] as const

export type Step = (typeof STEPS)[number]['id']
export const TOTAL_STEPS = STEPS.length
export const FIRST_STEP: Step = STEPS[0].id
export const LAST_STEP: Step = STEPS[STEPS.length - 1].id

/** id→meta lookup by Map: ids no longer align with array positions now that
 *  a host-conditional step can be absent (desktop has no Autostart step). */
const STEP_BY_ID = new Map<number, (typeof STEPS)[number]>(STEPS.map((s) => [s.id, s]))
export const stepMeta = (id: Step) => STEP_BY_ID.get(id)!

/** Array position of a step id — the display ordinal's base and the anchor
 *  for navigation. */
export const stepIndex = (id: Step): number => STEPS.findIndex((s) => s.id === id)

/** Array-order neighbours. Navigation MUST walk the STEPS array, never use
 *  id±1 arithmetic: the desktop host omits id 6 (no Autostart step), so
 *  id+1 from 'Updates' lands on an id with no meta and stepMeta() returns
 *  undefined — the "Cannot read properties of undefined (reading
 *  'subtitle')" crash of the packaged desktop wizard. */
export const nextStepId = (id: Step): Step | undefined => {
  const next = STEPS[stepIndex(id) + 1]
  return next ? next.id : undefined
}
export const prevStepId = (id: Step): Step | undefined => {
  const prev = STEPS[stepIndex(id) - 1]
  return prev ? prev.id : undefined
}
