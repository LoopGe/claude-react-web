import { describe, it, expect } from 'vitest'
import { buildNewLikeThisForm } from './new-like-this'
import type { SessionInfo, SessionGroup } from '../types'

const mkSource = (fields: Partial<SessionInfo>) => fields as unknown as SessionInfo

const groupOf = (id: string, sessionIds: string[]): SessionGroup =>
  ({ id, name: id, sessionIds })

describe('buildNewLikeThisForm', () => {
  it('copies cwd / model / permission mode / betas but never the title', () => {
    const form = buildNewLikeThisForm(
      mkSource({
        id: 's1',
        cwd: '/repo',
        model: 'claude-sonnet-4-6',
        permissionMode: 'acceptEdits',
        title: 'Fix bug',
        betas: ['context-1m-2025-08-07'],
      }),
      groupOf('g1', ['s1']),
      10,
    )
    expect(form).toMatchObject({
      cwd: '/repo',
      model: 'claude-sonnet-4-6',
      permissionMode: 'acceptEdits',
      betas: ['context-1m-2025-08-07'],
      groupId: 'g1',
    })
    // No `title` in the form at all — the copy is named by the server's
    // default (auto-derived) title, not "<source> (copy)".
    expect(form).not.toHaveProperty('title')
  })

  it('copies the main-thread persona', () => {
    const form = buildNewLikeThisForm(mkSource({ id: 's1', agent: 'reviewer' }), undefined, 10)
    expect(form.agent).toBe('reviewer')
  })

  it('omits agent when the source has no persona', () => {
    const form = buildNewLikeThisForm(mkSource({ id: 's1' }), undefined, 10)
    expect(form.agent).toBeUndefined()
  })

  it('leaves the title undefined when the source has none', () => {
    const form = buildNewLikeThisForm(mkSource({ id: 's1' }), undefined, 10)
    expect(form.title).toBeUndefined()
  })

  it('inherits the source group only; an ungrouped source stays ungrouped', () => {
    const form = buildNewLikeThisForm(mkSource({ id: 's1' }), undefined, 10)
    expect(form.groupId).toBeUndefined()
  })

  it('drops the group when the source group is already full', () => {
    const form = buildNewLikeThisForm(
      mkSource({ id: 's1' }),
      groupOf('g1', ['a', 'b', 'c']),
      3,
    )
    expect(form.groupId).toBeUndefined()
  })

  it('carries the source per-first-party-server overrides into the form', () => {
    const form = buildNewLikeThisForm(
      mkSource({ id: 's1', firstPartyTools: { 'git-tools': false } }),
      undefined,
      10,
    )
    expect(form.firstPartyTools).toEqual({ 'git-tools': false })
  })

  it('folds the legacy appToolsGit into the override map', () => {
    const form = buildNewLikeThisForm(mkSource({ id: 's1', appToolsGit: false }), undefined, 10)
    expect(form.firstPartyTools).toEqual({ 'git-tools': false })
  })

  it('omits firstPartyTools when the source has no overrides (inherit global)', () => {
    const form = buildNewLikeThisForm(mkSource({ id: 's1' }), undefined, 10)
    expect(form.firstPartyTools).toBeUndefined()
  })

  it('carries the plugin subset — a narrowed copy must not silently widen', () => {
    const form = buildNewLikeThisForm(
      mkSource({ id: 's1', enabledPlugins: ['plugA@mp1'] }),
      undefined,
      10,
    )
    expect(form.enabledPlugins).toEqual(['plugA@mp1'])
  })

  it('carries an explicit empty plugin subset (none enabled)', () => {
    // `[]` is meaningful ("no plugins") and distinct from `undefined`
    // ("all enabled") — collapsing the two would flip the copy's tool surface.
    const form = buildNewLikeThisForm(
      mkSource({ id: 's1', enabledPlugins: [] }),
      undefined,
      10,
    )
    expect(form.enabledPlugins).toEqual([])
  })

  it('leaves enabledPlugins undefined when the source uses all enabled plugins', () => {
    const form = buildNewLikeThisForm(mkSource({ id: 's1' }), undefined, 10)
    expect(form.enabledPlugins).toBeUndefined()
  })
})
