import { describe, expect, it } from 'vitest'
import type { PluginRuntimeState } from '../../shared/app-plugins/runtime-state.js'
import { getAppPluginRowStatus } from './app-plugin-status'

const cases: Array<{
  state: PluginRuntimeState
  files: string
  filesTone: 'muted' | 'danger'
  runtime: string
  runtimeTone: 'muted' | 'warn' | 'danger' | 'accent'
  reasonTone?: 'warn' | 'danger'
}> = [
  {
    state: 'disabled',
    files: 'No recorded file error',
    filesTone: 'muted',
    runtime: 'Not running',
    runtimeTone: 'muted',
  },
  {
    state: 'inactive',
    files: 'No recorded file error',
    filesTone: 'muted',
    runtime: 'Not running',
    runtimeTone: 'muted',
  },
  {
    state: 'activating',
    files: 'No recorded file error',
    filesTone: 'muted',
    runtime: 'Starting…',
    runtimeTone: 'accent',
  },
  {
    state: 'active',
    files: 'No recorded file error',
    filesTone: 'muted',
    runtime: 'Running',
    runtimeTone: 'accent',
  },
  {
    state: 'deactivating',
    files: 'No recorded file error',
    filesTone: 'muted',
    runtime: 'Stopping…',
    runtimeTone: 'muted',
  },
  {
    state: 'crashed',
    files: 'No recorded file error',
    filesTone: 'muted',
    runtime: 'Not running · crashed',
    runtimeTone: 'danger',
    reasonTone: 'danger',
  },
  {
    state: 'quarantined',
    files: 'No recorded file error',
    filesTone: 'muted',
    runtime: 'Stopped · crash loop',
    runtimeTone: 'danger',
    reasonTone: 'danger',
  },
  {
    state: 'incompatible',
    files: 'Manifest readable',
    filesTone: 'muted',
    runtime: 'Blocked · incompatible',
    runtimeTone: 'warn',
    reasonTone: 'warn',
  },
  {
    state: 'permission-required',
    files: 'No recorded file error',
    filesTone: 'muted',
    runtime: 'Blocked · permissions',
    runtimeTone: 'warn',
    reasonTone: 'warn',
  },
  {
    state: 'corrupted',
    files: 'File check failed',
    filesTone: 'danger',
    runtime: 'Unavailable · file error',
    runtimeTone: 'danger',
    reasonTone: 'danger',
  },
]

describe('getAppPluginRowStatus', () => {
  it.each(cases)(
    'maps $state without using enabled as a runtime signal',
    ({ state, files, filesTone, runtime, runtimeTone, reasonTone }) => {
      const result = getAppPluginRowStatus({ enabled: true, runtimeState: state })
      expect(result.intent).toEqual({ label: 'Enabled', tone: 'muted' })
      expect(result.files.label).toBe(files)
      expect(result.files.tone).toBe(filesTone)
      expect(result.runtime.label).toBe(runtime)
      expect(result.runtime.tone).toBe(runtimeTone)
      expect(result.reason?.tone).toBe(reasonTone)
    },
  )

  it('derives user intent only from enabled', () => {
    for (const { state } of cases) {
      const enabled = getAppPluginRowStatus({ enabled: true, runtimeState: state })
      const disabled = getAppPluginRowStatus({ enabled: false, runtimeState: state })
      expect(enabled.intent.label).toBe('Enabled')
      expect(disabled.intent.label).toBe('Disabled')
      expect(disabled.runtime).toEqual(enabled.runtime)
      expect(disabled.files).toEqual(enabled.files)
    }
  })

  it('suppresses stale errors outside failure states', () => {
    for (const state of ['disabled', 'inactive', 'activating', 'active', 'deactivating'] as const) {
      const result = getAppPluginRowStatus({ enabled: true, runtimeState: state, lastError: 'stale failure' })
      expect(result.reason).toBeNull()
    }
  })

  it('keeps fixed reasons without lastError and appends details without parsing them', () => {
    const withoutDetail = getAppPluginRowStatus({ enabled: true, runtimeState: 'crashed' })
    expect(withoutDetail.reason?.text).toBe('The plugin subprocess exited unexpectedly.')
    expect(withoutDetail.reason?.detail).toBeNull()

    const withDetail = getAppPluginRowStatus({
      enabled: true,
      runtimeState: 'crashed',
      lastError: 'exit code 17',
    })
    expect(withDetail.reason?.text).toBe(withoutDetail.reason?.text)
    expect(withDetail.reason?.detail).toBe('exit code 17')

    const quarantined = getAppPluginRowStatus({ enabled: true, runtimeState: 'quarantined' })
    expect(quarantined.reason?.text).toBe(
      'Activation is blocked after repeated crashes. Disable and enable the plugin to reset it.',
    )
  })

  it('limits file and running hints to their actual guarantees', () => {
    const active = getAppPluginRowStatus({ enabled: true, runtimeState: 'active' })
    expect(active.runtime.hint).toBe(
      'Activation was confirmed by the host. This is not a live OS process heartbeat.',
    )
    expect(active.files.hint).toContain('last validation')

    const incompatible = getAppPluginRowStatus({ enabled: true, runtimeState: 'incompatible' })
    expect(incompatible.files.hint).toContain('runtime service entry is checked when activation is attempted')
    expect(incompatible.reason?.text).toBe(
      'The manifest was read, but its structure or engine requirements are not supported by this host.',
    )
  })
})
