import { describe, it, expect } from 'vitest'
import { snapshotFailed, snapshotLoaded, snapshotView } from './request-snapshot'

describe('snapshotView', () => {
  it('reports loading until the current key settles', () => {
    const view = snapshotView(null, 'a')
    expect(view).toEqual({ data: null, loading: true, error: null })
  })

  it('is not loading when the key is disabled (null)', () => {
    expect(snapshotView(null, null).loading).toBe(false)
    expect(snapshotView(snapshotLoaded('a', ['x']), null).loading).toBe(false)
  })

  it('exposes settled data and clears the error', () => {
    expect(snapshotView(snapshotLoaded('a', ['x']), 'a')).toEqual({
      data: ['x'],
      loading: false,
      error: null,
    })
  })

  it('keeps the previous data while a new key is in flight', () => {
    // The refresh case: the panel must not blank out mid-fetch.
    const view = snapshotView(snapshotLoaded('a', ['old']), 'b')
    expect(view.data).toEqual(['old'])
    expect(view.loading).toBe(true)
  })

  it('hides an error that belongs to a previous key', () => {
    const view = snapshotView(snapshotFailed(null, 'a', 'boom'), 'b')
    expect(view.error).toBeNull()
    expect(view.loading).toBe(true)
  })

  it('reports the error of the current key', () => {
    expect(snapshotView(snapshotFailed(null, 'a', 'boom'), 'a')).toEqual({
      data: null,
      loading: false,
      error: 'boom',
    })
  })
})

describe('snapshotFailed', () => {
  it('keeps the last good data so a failed refresh cannot blank the content', () => {
    const failed = snapshotFailed(snapshotLoaded('a', ['old']), 'b', 'boom')
    expect(failed).toEqual({ key: 'b', data: ['old'], error: 'boom' })
  })

  it('starts from null when nothing ever loaded', () => {
    expect(snapshotFailed(null, 'a', 'boom')).toEqual({ key: 'a', data: null, error: 'boom' })
  })
})

describe('snapshotLoaded', () => {
  it('carries a degraded-response warning alongside the data', () => {
    expect(snapshotLoaded('a', ['x'], 'github down')).toEqual({ key: 'a', data: ['x'], error: 'github down' })
  })

  it('defaults the warning to null', () => {
    expect(snapshotLoaded('a', ['x']).error).toBeNull()
  })
})
