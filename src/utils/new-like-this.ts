import type { NewSessionForm, SessionGroup, SessionInfo } from '../types'
import { firstPartyOverridesForCreate } from '../../shared/session-info'

/** Build the "New like this" create form for a source session. Copies the
 *  working context (cwd / model / permission mode / betas / title) AND the
 *  per-first-party-server tool overrides (`firstPartyOverridesForCreate` —
 *  a copy with apptools silently re-enabled would surprise the user), and
 *  inherits the source's group only. A full source group drops the group
 *  (`undefined` → the copy is created ungrouped): the context menu already
 *  warns + confirms that case before this runs, so no dialog/toast here —
 *  dropping the group also keeps handleAddToGroup from re-firing the
 *  "group full" toast. */
export function buildNewLikeThisForm(
  source: SessionInfo,
  sourceGroup: SessionGroup | undefined,
  maxGroupSize: number,
): NewSessionForm {
  const form: NewSessionForm = {
    cwd: source.cwd,
    model: source.model,
    permissionMode: source.permissionMode,
    title: source.title ? `${source.title} (copy)` : undefined,
    betas: source.betas,
    firstPartyTools: firstPartyOverridesForCreate(source),
    groupId: sourceGroup?.id,
  }
  if (sourceGroup && sourceGroup.sessionIds.length >= maxGroupSize) {
    form.groupId = undefined
  }
  return form
}
