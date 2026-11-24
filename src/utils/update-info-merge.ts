// Merge an incoming update snapshot (WS frame OR GET response) into the
// previous hook state. Two invariants:
//
//   1. checkedAt fence — the GET route awaits CLI/SDK overlays, so a response
//      built from an older cache can land AFTER a fresher frame; core fields
//      must not regress. A `checking` placeholder (no checkedAt) can't clobber
//      a checked snapshot; a `disabled` transition always applies.
//   2. Overlay preservation — frames carry only the core checker snapshot;
//      the GET-only overlays (repoUrl / claudeCli / agentSdk) the About tab
//      renders survive frames and are refreshed by GETs.

import type { UpdateInfo } from '../../shared/update-info'

export function mergeUpdateInfoSnapshot(prev: UpdateInfo | null, incoming: UpdateInfo): UpdateInfo {
  let core: UpdateInfo
  if (prev === null) {
    core = incoming
  } else if (incoming.disabled) {
    core = incoming
  } else if (prev.checkedAt !== undefined && incoming.checkedAt === undefined) {
    core = prev
  } else if (
    prev.checkedAt !== undefined &&
    incoming.checkedAt !== undefined &&
    incoming.checkedAt < prev.checkedAt
  ) {
    core = prev
  } else {
    core = incoming
  }

  const merged: UpdateInfo = { ...core }
  const repoUrl = incoming.repoUrl ?? prev?.repoUrl
  const claudeCli = incoming.claudeCli ?? prev?.claudeCli
  const agentSdk = incoming.agentSdk ?? prev?.agentSdk
  if (repoUrl !== undefined) merged.repoUrl = repoUrl
  else delete merged.repoUrl
  if (claudeCli !== undefined) merged.claudeCli = claudeCli
  else delete merged.claudeCli
  if (agentSdk !== undefined) merged.agentSdk = agentSdk
  else delete merged.agentSdk
  return merged
}