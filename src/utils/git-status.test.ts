import { describe, expect, it } from 'vitest'
import { GIT_STATUS_LABELS, gitStatusTitle } from './git-status'

describe('GIT_STATUS_LABELS', () => {
  it('maps the common git status letters to human labels', () => {
    expect(GIT_STATUS_LABELS.M).toBe('modified')
    expect(GIT_STATUS_LABELS.A).toBe('added')
    expect(GIT_STATUS_LABELS.D).toBe('deleted')
    expect(GIT_STATUS_LABELS.R).toBe('renamed')
    expect(GIT_STATUS_LABELS.C).toBe('copied')
    expect(GIT_STATUS_LABELS.U).toBe('unmerged')
    expect(GIT_STATUS_LABELS.T).toBe('type changed')
    expect(GIT_STATUS_LABELS['?']).toBe('untracked')
  })
})

describe('gitStatusTitle', () => {
  it('formats a known status as "letter — label"', () => {
    expect(gitStatusTitle('M')).toBe('M — modified')
    expect(gitStatusTitle('?')).toBe('? — untracked')
  })

  it('falls back to the raw status when unknown', () => {
    expect(gitStatusTitle('X')).toBe('X')
  })
})
