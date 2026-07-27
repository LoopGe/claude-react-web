// Client-side `when` evaluation for plugin contributions.
//
// Reuses the shared parser/evaluator (shared/app-plugins/when.ts) so the
// client and server agree on what a `when` clause means. This module builds
// the WhenContext from the current UI state — the host-side doesn't know the
// live theme / active session / selection, so evaluation happens here.

import { compileWhen, evalWhen, type WhenContext } from '../../shared/app-plugins/when.js'
import type { PluginCommandContribution, PluginContextMenuContribution, PluginActionContribution } from '../../shared/app-plugins/contributions.js'

export interface WhenContextInput {
  theme?: 'dark' | 'light'
  sessionActive?: boolean
  sessionWorking?: boolean
  sessionProvider?: string
  workspaceTrusted?: boolean
  messageHasSelection?: boolean
  messageSelectionLength?: number
  messageContentType?: string
  gitIsRepo?: boolean
  gitDirty?: boolean
}

/** Build the flat WhenContext the evaluator expects, keyed by the canonical
 *  context key names. Missing values are omitted (undefined → falsy in `!key`
 *  and "not equal" in comparisons). */
export function buildWhenContext(input: WhenContextInput): WhenContext {
  const ctx: WhenContext = {}
  if (input.theme != null) ctx['theme'] = input.theme
  if (input.sessionActive != null) ctx['session.active'] = input.sessionActive
  if (input.sessionWorking != null) ctx['session.working'] = input.sessionWorking
  if (input.sessionProvider != null) ctx['session.provider'] = input.sessionProvider
  if (input.workspaceTrusted != null) ctx['workspace.trusted'] = input.workspaceTrusted
  if (input.messageHasSelection != null) ctx['message.hasSelection'] = input.messageHasSelection
  if (input.messageSelectionLength != null) ctx['message.selectionLength'] = input.messageSelectionLength
  if (input.messageContentType != null) ctx['message.contentType'] = input.messageContentType
  if (input.gitIsRepo != null) ctx['git.isRepo'] = input.gitIsRepo
  if (input.gitDirty != null) ctx['git.dirty'] = input.gitDirty
  ctx['plugin.enabled'] = true // contributions only exist for enabled plugins
  return ctx
}

/** True iff a contribution's `when` clause holds against `ctx`. A missing/
 *  empty `when` is always true. A malformed `when` (failed to compile) is
 *  always false — the contribution is hidden rather than shown wrongly. */
export function whenHolds(when: string | undefined, ctx: WhenContext): boolean {
  if (!when || when.trim() === '') return true
  const compiled = compileWhen(when)
  if (!compiled) return false
  return evalWhen(compiled.node, ctx)
}

/** Filter + sort a contribution list by `when` + `order`, tagging each with
 *  its owning plugin id. Shared by the palette, slots, and context menus. */
export function filterContributions<T extends { when?: string; order?: number; pluginId: string }>(
  items: T[],
  ctx: WhenContext,
): T[] {
  return items
    .filter((item) => whenHolds(item.when, ctx))
    .map((item) => ({ item, order: item.order ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.order - b.order)
    .map((x) => x.item)
}

export type { PluginCommandContribution, PluginContextMenuContribution, PluginActionContribution }
