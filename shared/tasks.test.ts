import { describe, expect, it } from 'vitest'
import { isTerminalTaskStatus, normalizeTaskType } from './tasks.js'

describe('normalizeTaskType', () => {
  it('folds the frame discriminants onto the friendly labels the UI matches on', () => {
    // TasksPanel's TypeIcon matches 'shell' / 'subagent' / 'workflow'; the
    // task_* frames spell those local_bash / local_agent / local_workflow.
    expect(normalizeTaskType('local_bash')).toBe('shell')
    expect(normalizeTaskType('local_agent')).toBe('subagent')
    expect(normalizeTaskType('local_workflow')).toBe('workflow')
  })

  it('leaves an already-friendly label untouched (idempotent)', () => {
    for (const t of ['shell', 'subagent', 'monitor', 'workflow']) {
      expect(normalizeTaskType(t)).toBe(t)
      expect(normalizeTaskType(normalizeTaskType(t))).toBe(t)
    }
  })

  it('passes an unknown discriminant through rather than dropping it', () => {
    // Mirrors the SDK's own documented fallback for BackgroundTaskSummary.type.
    expect(normalizeTaskType('remote_agent')).toBe('remote_agent')
    expect(normalizeTaskType('something_new')).toBe('something_new')
  })

  it('treats absent / empty as absent', () => {
    expect(normalizeTaskType(undefined)).toBeUndefined()
    expect(normalizeTaskType('')).toBeUndefined()
  })
})

describe('isTerminalTaskStatus', () => {
  it('covers exactly the four terminal statuses', () => {
    expect(['completed', 'failed', 'killed', 'stopped'].every(isTerminalTaskStatus)).toBe(true)
    expect(['pending', 'running', 'paused'].some(isTerminalTaskStatus)).toBe(false)
  })
})
