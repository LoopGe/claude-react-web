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
    // The copy runs on the same provider — native sessions must not silently
    // revert to the claude subprocess.
    provider: source.provider,
    // An isolated source runs inside its worktree; the copy must land in the
    // main repo (the source's worktree belongs to the source session and is
    // removed with it). Mirrors the server fork rule.
    cwd: source.worktree?.mainRepoPath ?? source.cwd,
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

/** The `POST /sessions` body for the "Restart" action: create the replacement
 *  Y, then delete the source X. Y gets a fresh id with no persisted meta, so
 *  every per-session choice must be carried explicitly here — an omitted field
 *  silently reverts to the global default. `joinGroupOf` / `evictingSource`
 *  make the server tag the `session-created(Y)` broadcast so every connected
 *  tab slots Y where X was instead of appending it beside the doomed source. */
export type RestartSessionBody = Pick<
  NewSessionForm,
  | 'provider'
  | 'cwd'
  | 'model'
  | 'permissionMode'
  | 'betas'
  | 'firstPartyTools'
  | 'enabledPlugins'
  | 'enabledMcpServers'
  | 'title'
> & {
  showPinnedUserMessage?: boolean
  autoRecap?: boolean
  toolGroupCards?: boolean
  autoExpandRunningGroups?: boolean
  showMessageHeaders?: boolean
  joinGroupOf: string
  evictingSource: true
}

export function buildRestartSessionBody(source: SessionInfo): RestartSessionBody {
  return {
    // Same provider as the source — a native session restarted as claude (or
    // the reverse) would change the whole execution model behind the user.
    provider: source.provider,
    // An isolated source runs inside its worktree; restart Y must land in the
    // main repo (X's delete removes the worktree dir Y would otherwise be
    // spawned into). Mirrors the server fork rule.
    cwd: source.worktree?.mainRepoPath ?? source.cwd,
    model: source.model,
    permissionMode: source.permissionMode,
    // Preserve beta flags (notably `context-1m-...`) so restart doesn't
    // silently drop the window from 1M back to 200k.
    betas: source.betas,
    // Preserve per-first-party-server overrides so a restarted session keeps
    // its tool set (create-time prefs honor them on FIRST spawn).
    firstPartyTools: firstPartyOverridesForCreate(source),
    // Preserve the plugin subset (undefined = all enabled, `[]` = none) — with
    // a fresh id and no persisted meta, omitting it would silently widen the
    // session to every globally-enabled plugin.
    enabledPlugins: source.enabledPlugins,
    // Preserve the MCP selection — the create route treats an absent field as
    // no selection, so a legacy `undefined` keeps the historical behavior via
    // JSON.stringify's key drop.
    enabledMcpServers: source.mcpServerNames,
    // Preserve the panel's per-session UI overrides; `undefined` (inherit) is
    // dropped by JSON.stringify, which the create route treats as inherit.
    showPinnedUserMessage: source.showPinnedUserMessage,
    autoRecap: source.autoRecap,
    toolGroupCards: source.toolGroupCards,
    autoExpandRunningGroups: source.autoExpandRunningGroups,
    showMessageHeaders: source.showMessageHeaders,
    title: source.title,
    joinGroupOf: source.id,
    // X is being evicted by this restart (swapSession replaces X→Y), so the
    // server tags the created(Y) broadcast with evictingSource. The client
    // uses that flag to keep Y pending (NOT appended) until swapSession places
    // it in X's exact slot — no group-tail flash.
    evictingSource: true,
  }
}
