import type { AppPluginClientInfo, PluginRuntimeState } from '../../shared/app-plugins/runtime-state.js'

export type AppPluginStatusTone = 'muted' | 'warn' | 'danger' | 'accent'

export interface AppPluginRowStatus {
  intent: { label: 'Enabled' | 'Disabled'; tone: 'muted' }
  files: { label: string; tone: 'muted' | 'danger'; hint: string }
  runtime: { label: string; tone: AppPluginStatusTone; hint?: string }
  reason: { text: string; detail: string | null; tone: 'warn' | 'danger' } | null
}

const NORMAL_FILES = {
  label: 'No recorded file error',
  tone: 'muted',
  hint: 'No plugin directory or manifest file error is currently recorded. File status reflects the last validation, not a live filesystem check.',
} as const

const RUNTIME: Record<PluginRuntimeState, { label: string; tone: AppPluginStatusTone; hint?: string }> = {
  disabled: { label: 'Not running', tone: 'muted' },
  inactive: { label: 'Not running', tone: 'muted' },
  activating: { label: 'Starting…', tone: 'accent' },
  active: {
    label: 'Running',
    tone: 'accent',
    hint: 'Activation was confirmed by the host. This is not a live OS process heartbeat.',
  },
  deactivating: { label: 'Stopping…', tone: 'muted' },
  crashed: { label: 'Not running · crashed', tone: 'danger' },
  quarantined: { label: 'Stopped · crash loop', tone: 'danger' },
  incompatible: { label: 'Blocked · incompatible', tone: 'warn' },
  'permission-required': { label: 'Blocked · permissions', tone: 'warn' },
  corrupted: { label: 'Unavailable · file error', tone: 'danger' },
}

const CORRUPTED_REASON = {
  text: 'The plugin directory or crw-plugin.json could not be read or parsed during the last validation.',
  tone: 'danger',
} as const

const REASONS: Partial<Record<PluginRuntimeState, { text: string; tone: 'warn' | 'danger' }>> = {
  crashed: { text: 'The plugin subprocess exited unexpectedly.', tone: 'danger' },
  quarantined: {
    text: 'Activation is blocked after repeated crashes. Disable and enable the plugin to reset it.',
    tone: 'danger',
  },
  incompatible: {
    text: 'The manifest was read, but its structure or engine requirements are not supported by this host.',
    tone: 'warn',
  },
  'permission-required': {
    text: 'This version requires permission consent before activation.',
    tone: 'warn',
  },
  corrupted: CORRUPTED_REASON,
}

/** Project the persisted intent and last validation/runtime outcomes into row
 * copy. No filesystem or process probe happens here: `active` is the host's
 * last confirmed activation, and a non-corrupted state only means no file
 * error is currently recorded. */
export function getAppPluginRowStatus(
  plugin: Pick<AppPluginClientInfo, 'enabled' | 'runtimeState' | 'lastError'>,
): AppPluginRowStatus {
  const state = plugin.runtimeState
  const reason = REASONS[state]
  return {
    intent: { label: plugin.enabled ? 'Enabled' : 'Disabled', tone: 'muted' },
    files:
      state === 'incompatible'
        ? {
            label: 'Manifest readable',
            tone: 'muted',
            hint: 'The plugin directory and manifest were readable at the last validation. The runtime service entry is checked when activation is attempted.',
          }
        : state === 'corrupted'
          ? { label: 'File check failed', tone: 'danger', hint: CORRUPTED_REASON.text }
          : NORMAL_FILES,
    runtime: RUNTIME[state],
    reason: reason ? { ...reason, detail: plugin.lastError ?? null } : null,
  }
}
