import { describe, expect, it } from 'vitest'
import { MAX_TERMINAL_TASKS, TASK_SNAPSHOT_MAX_CHARS, isTerminalTaskStatus, normalizeTaskType, pageTaskResult, projectTasksSnapshot, taskResultVersion } from './tasks.js'
import type { TaskRecordUi } from './tasks.js'

describe('MAX_TERMINAL_TASKS', () => {
  it('is exported and pinned at 50', () => {
    expect(MAX_TERMINAL_TASKS).toBe(50)
  })
})

describe('normalizeTaskType', () => {
  it('folds the frame discriminants onto the friendly labels the UI matches on', () => {
    // TasksPanel's TypeIcon matches 'shell' / 'subagent' / 'monitor' / 'workflow';
    // the task_* frames spell those local_bash / local_agent / local_monitor /
    // local_workflow.
    expect(normalizeTaskType('local_bash')).toBe('shell')
    expect(normalizeTaskType('local_agent')).toBe('subagent')
    expect(normalizeTaskType('local_monitor')).toBe('monitor')
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

describe('pageTaskResult', () => {
  it('reconstructs unicode text through surrogate-safe continuation offsets', () => {
    const original = 'start😀' + 'x'.repeat(300) + '结束🚀'
    let offset = 0
    let reconstructed = ''
    const pages: number[] = []
    do {
      const page = pageTaskResult(original, offset, 7)
      expect(page.result).not.toMatch(/^[\uDC00-\uDFFF]/)
      expect(page.result).not.toMatch(/[\uD800-\uDBFF]$/)
      reconstructed += page.result
      pages.push(page.offset)
      offset = page.nextOffset
      if (!page.hasMore) break
    } while (pages.length < 100)
    expect(reconstructed).toBe(original)
    expect(offset).toBe(original.length)
  })

  it('keeps a backward page end fixed when its start crosses a surrogate pair', () => {
    const page = pageTaskResult('a😀b😀c', 2, 4)
    expect(page).toMatchObject({ offset: 3, nextOffset: 6, result: 'b😀' })
  })

  it('keeps a surrogate pair present across a tail and its previous page', () => {
    const text = 'x'.repeat(22) + '😀' + 'y'.repeat(131_070)
    const tail = pageTaskResult(text, text.length - 131_072, 131_072)
    const previous = pageTaskResult(text, tail.previousOffset, tail.offset - tail.previousOffset)
    expect(previous.nextOffset).toBe(tail.offset)
    expect(previous.result + tail.result).toBe(text)
  })

  it('keeps a surrogate pair whole when it spans the requested window', () => {
    const page = pageTaskResult('abc😀x', 0, 4)
    expect(page.result).toBe('abc')
    expect(page.nextOffset).toBe(3)
    expect(page.result.length).toBeLessThanOrEqual(4)
    expect(pageTaskResult('😀', 0, 1)).toMatchObject({ result: '😀', nextOffset: 2 })
    expect(pageTaskResult('😀😀a', 1, 2)).toMatchObject({ offset: 2, result: '😀', nextOffset: 4 })
  })

  it('advances after a surrogate-adjusted start instead of returning an empty page', () => {
    expect(pageTaskResult('a😀b', 2, 1)).toMatchObject({
      offset: 3, result: 'b', nextOffset: 4, hasMore: false,
    })
  })

  it('returns an empty final page at totalChars and rejects invalid ranges', () => {
    expect(pageTaskResult('abc', 3, 10)).toMatchObject({ result: '', nextOffset: 3, hasMore: false })
    expect(() => pageTaskResult('abc', 4, 10)).toThrow(RangeError)
    expect(() => pageTaskResult('abc', -1, 10)).toThrow(RangeError)
    expect(() => pageTaskResult('abc', 0, 0)).toThrow(RangeError)
  })
})

describe('projectTasksSnapshot', () => {
  const task = (patch: Partial<TaskRecordUi>): TaskRecordUi => ({
    taskId: 't1', description: 'task', status: 'completed', updatedAt: 123, ...patch,
  })

  it('keeps a small result inline and exposes its lifecycle metadata', () => {
    const [projected] = projectTasksSnapshot([task({ result: 'ok', runId: 'run-a' })])
    expect(projected.result).toBe('ok')
    expect(projected.resultRef).toEqual({
      totalChars: 2, hasResult: true, isError: false,
      projection: 'full',
      resultVersion: taskResultVersion('ok'),
    })
  })

  it('bounds a large result without mutating the canonical record', () => {
    const fullResult = 'start' + 'x'.repeat(100_000) + 'tail'
    const canonical = task({ status: 'failed', result: fullResult })
    const [projected] = projectTasksSnapshot([canonical])
    expect(projected.result).toBeUndefined()
    expect(projected.resultRef).toMatchObject({
      totalChars: fullResult.length, hasResult: true,
      isError: true, projection: 'partial',
    })
    expect(canonical.result).toHaveLength(fullResult.length)
    expect(canonical.resultRef).toBeUndefined()
  })

  it('keeps the whole projected snapshot bounded under many large results', () => {
    const records = Array.from({ length: 51 }, (_, i) => task({
      taskId: `t${i}`, status: 'failed',
      result: i < 4 ? 'x'.repeat(3_500_000 + i) : i === 4 ? 'y'.repeat(1_062_679) : 'z'.repeat(100_000),
    }))
    expect(JSON.stringify(records).length).toBeGreaterThan(16_000_000)
    const projected = projectTasksSnapshot(records)
    expect(JSON.stringify(projected).length).toBeLessThan(TASK_SNAPSHOT_MAX_CHARS)
    expect(projected.every((record) => record.resultRef?.projection === 'partial')).toBe(true)
    expect(projected.every((record) => record.resultRef?.hasResult)).toBe(true)
  })

  it('omits the body for partial results instead of sending a legacy-unsafe preview', () => {
    const [projected] = projectTasksSnapshot([
      task({ result: 'x'.repeat(20_000) + '😀'.repeat(10_000) }),
    ])
    expect(projected.result).toBeUndefined()
    expect(projected.resultRef?.projection).toBe('partial')
  })

  it('bounds free-form metadata and resource links as well as result bodies', () => {
    const [projected] = projectTasksSnapshot([task({
      description: 'd'.repeat(10_000),
      progressSummary: 'p'.repeat(20_000),
      lastToolName: 'l'.repeat(2_000),
      resourceLinks: Array.from({ length: 100 }, (_, i) => ({
        uri: i < 20 ? `https://example.com/${i}` : `https://example.com/${i}/${'u'.repeat(5_000)}`,
        name: 'n'.repeat(2_000), title: 't'.repeat(2_000), mimeType: 'm'.repeat(2_000),
      })),
    })])
    expect(projected.description.length).toBeLessThanOrEqual(2_048)
    expect(projected.progressSummary!.length).toBeLessThanOrEqual(4_096)
    expect(projected.lastToolName!.length).toBeLessThanOrEqual(256)
    expect(projected.resourceLinks).toHaveLength(100)
    expect(projected.resourceLinks![0].uri).toBe('https://example.com/0')
    expect(projected.resourceLinks![99].uri.length).toBeGreaterThan(5_000)
    expect(projected.resourceLinks![0].name.length).toBeLessThanOrEqual(256)
    expect(projected.resourceLinks![0].title!.length).toBeLessThanOrEqual(512)
    expect(projected.resourceLinks![0].mimeType!.length).toBeLessThanOrEqual(256)
  })

  it('preserves task identity and lifecycle for transport chunking when metadata is large', () => {
    const projected = projectTasksSnapshot(Array.from({ length: 100 }, (_, i) => task({
      taskId: `t${i}`, progressSummary: 'p'.repeat(4_096), result: 'ok',
    })))
    expect(projected).toHaveLength(100)
    expect(projected.every((record) => record.resultRef?.hasResult)).toBe(true)
    expect(projected.every((record) => record.status === 'completed')).toBe(true)
  })

  it('preserves all tasks instead of replacing an extreme roster with a synthetic failure', () => {
    const projected = projectTasksSnapshot(Array.from({ length: 5_000 }, (_, i) => task({
      taskId: `task-${i}-${'x'.repeat(200)}`,
    })))
    expect(projected).toHaveLength(5_000)
    expect(projected[0].taskId).toContain('task-0-')
    expect(projected.some((record) => record.taskId === '__task_snapshot_overflow__')).toBe(false)
  })

  it('does not spend inline budget on omitted bodies and versions same-tick replacements by content', () => {
    const records = [
      ...Array.from({ length: 20 }, (_, i) => task({ taskId: `large${i}`, result: 'x'.repeat(100_000) })),
      task({ taskId: 'small', result: 'ok' }),
    ]
    const projected = projectTasksSnapshot(records)
    expect(projected.at(-1)?.result).toBe('ok')
    expect(projected.at(-1)?.resultRef?.projection).toBe('full')
    const a = projectTasksSnapshot([task({ result: 'aaaa' })])[0].resultRef
    const b = projectTasksSnapshot([task({ result: 'bbbb' })])[0].resultRef
    expect(a?.resultVersion).not.toBe(b?.resultVersion)
  })

  it('reuses projected records when canonical identity and budget mode are unchanged', () => {
    const canonical = task({ result: 'ok' })
    const first = projectTasksSnapshot([canonical])[0]
    const second = projectTasksSnapshot([canonical])[0]
    expect(second).toBe(first)
  })

  it('distinguishes an empty result from captured non-empty output', () => {
    const [empty, whitespace] = projectTasksSnapshot([
      task({ taskId: 'empty', result: '' }),
      task({ taskId: 'space', result: '  ' }),
    ])
    expect(empty.resultRef).toMatchObject({ totalChars: 0, hasResult: false, projection: 'full' })
    expect(whitespace.resultRef).toMatchObject({ totalChars: 2, hasResult: false, projection: 'full' })
  })
})
