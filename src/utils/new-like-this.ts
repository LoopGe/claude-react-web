import type { NewSessionForm, SessionGroup, SessionInfo } from '../types'
import { firstPartyOverridesForCreate } from '../../shared/session-info'

/** Build the "New like this" create form for a source session. Copies the
 *  working context (cwd / model / persona / permission mode / betas)
 *  AND the per-session tool-surface selections — the per-first-party-server
 *  overrides (`firstPartyOverridesForCreate`: a copy with git-tools silently
 *  re-enabled would surprise the user) and the plugin subset (`enabledPlugins`,
 *  where `undefined` means ALL enabled — dropping a narrowed subset would
 *  silently widen the copy). Inherits the source's group only. A full source
 *  group drops the group (`undefined` → the copy is created ungrouped): the
 *  context menu already warns + confirms that case before this runs, so no
 *  dialog/toast here — dropping the group also keeps handleAddToGroup from
 *  re-firing the "group full" toast. */
export function buildNewLikeThisForm(
  source: SessionInfo,
  sourceGroup: SessionGroup | undefined,
  maxGroupSize: number,
): NewSessionForm {
  const form: NewSessionForm = {
    cwd: source.cwd,
    model: source.model,
    // Deliberately NOT copying `source.modelGroupId`: create() 400s on a
    // deleted model group while the source session itself self-heals on
    // respawn. Copying the resolved `model` keeps the copy strictly
    // no-worse than the source; the user can re-pin a group from ChatPanel.
    // (Session-group membership IS copied below — that path drops a full
    // group instead of failing.)
    // Main-thread persona. A copy that silently drops it would be a different
    // kind of session than the one the user pointed at — the same reason the
    // first-party tool overrides are carried below. The create route rejects a
    // name whose definition has since been disabled, which is the intended
    // failure: better a visible 400 than a quietly plain session.
    agent: source.agent,
    permissionMode: source.permissionMode,
    // Deliberately NOT copying `source.title`: the copy gets the server's
    // default (auto-derived) title like any fresh session, so the sidebar
    // doesn't fill up with "(copy)" twins.
    betas: source.betas,
    firstPartyTools: firstPartyOverridesForCreate(source),
    enabledPlugins: source.enabledPlugins,
    groupId: sourceGroup?.id,
  }
  if (sourceGroup && sourceGroup.sessionIds.length >= maxGroupSize) {
    form.groupId = undefined
  }
  return form
}
