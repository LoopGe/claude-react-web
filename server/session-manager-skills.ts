// Session skill policy + tool-profile management: reload, per-session
// override pin/clear, dynamic flag-layer re-application, and the
// global-policy-changed fan-out.
//
// Extracted from session-manager.ts for modularity. Mirrors the
// PermissionBroker/SessionMcpManager pattern: SessionManager constructs one
// SessionSkillManager, injecting the handful of its own methods this module
// needs, and keeps thin proxy methods on its own public API so routes and
// other callers (including SessionManager.fork()) see no change.
//
// SessionSkillManager owns:
//   - reloadSkills / reloadSkillsForCwd (SDK skill-reload passthrough)
//   - setSkillOverride / applyDynamicSkillOverrides (per-session pin +
//     flag-layer re-application)
//   - getToolProfile / setToolProfile (RAM-only tool-surface pin)
//   - reapplyGlobalSkillsToInheritingSessions (global-policy-changed fan-out)
//
// SessionManager retains:
//   - The spawn-time skill policy projection (applySkillPolicyToOptions,
//     Session.skillOverride field) — this module only handles MID-session
//     changes via applyFlagSettings, not the initial Options.skills.

import { policyToDynamicSkillOverrides, type SessionSkillOverride, type EffectiveSkillPolicy } from '../shared/skills.js'
import type { SessionToolProfile } from '../shared/tool-profile.js'
import { listSkills } from './skills.js'
import type { Session, SessionInfo } from './session-types.js'
import type { ProviderCapabilities, ProviderSessionHandle } from './providers/types.js'
import { createLogger } from './log.js'

const log = createLogger('skill-manager')

/** Callbacks the skill manager needs from its owner (SessionManager). Kept
 *  minimal and generic (no SessionManager import), same convention as
 *  McpManagerDeps / HealthMonitorDeps. */
export interface SkillManagerDeps {
  /** Resolve a session by id, requiring it to be alive (running Query). */
  requireLive(id: string): Session
  /** Bind + capability-gate + error-wrap a provider handle method. */
  requireHandleMethod<T extends (...args: never[]) => unknown>(
    s: Session,
    method: keyof ProviderSessionHandle,
    action: string,
    capability?: keyof ProviderCapabilities,
  ): T
  /** Time an SDK control round-trip (slow-call logging + 502 wrapping). */
  timeSdkControl<T>(id: string, label: string, fn: () => Promise<T>): Promise<T>
  /** Broadcast a slash-command-list change (reloadSkills may add/remove
   *  skill-backed commands). */
  broadcastCommandsChanged(id: string, commands: unknown[]): void
  /** Persist + broadcast a session update. */
  persist(s: Session): void
  /** Project a live session into its public SessionInfo shape. */
  info(s: Session): SessionInfo
  /** Live sessions map — reloadSkillsForCwd / reapplyGlobalSkillsToInheritingSessions
   *  iterate every live session. */
  sessions: Map<string, Session>
  /** Resolve a session's effective skill policy from its override + the
   *  global config (session-manager.ts's local effectiveSkillPolicyFor,
   *  which pulls defaultConfig.skillLoadMode/enabledSkills — not exported
   *  from shared/skills.ts, so it's injected here). */
  effectiveSkillPolicyFor(override: SessionSkillOverride | undefined): EffectiveSkillPolicy
}

export class SessionSkillManager {
  constructor(private deps: SkillManagerDeps) {}

  async reloadSkills(id: string) {
    const s = this.deps.requireLive(id)
    const fn = this.deps.requireHandleMethod<() => Promise<unknown>>(s, 'reloadSkills', 'skill reload')
    const result = await this.deps.timeSdkControl(id, 'reloadSkills', fn)
    const skills = (result && typeof result === 'object' && Array.isArray((result as { skills?: unknown }).skills))
      ? (result as { skills: unknown[] }).skills
      : []
    if (skills.length > 0) this.deps.broadcastCommandsChanged(id, skills)
    return result
  }

  async reloadSkillsForCwd(cwd?: string): Promise<{ reloaded: string[]; failed: { id: string; error: string }[] }> {
    const target = cwd ? cwd.toLowerCase() : undefined
    const reloaded: string[] = []
    const failed: { id: string; error: string }[] = []
    for (const s of this.deps.sessions.values()) {
      if (!s.running || s.terminated) continue
      if (target && (s.cwd ?? '').toLowerCase() !== target) continue
      if (!s.handle.reloadSkills) continue
      try {
        await this.reloadSkills(s.id)
        reloaded.push(s.id)
      } catch (err) {
        failed.push({ id: s.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { reloaded, failed }
  }

  /** Pin a session's skill policy override. Forwards the effective policy to
   *  the SDK as a per-skill `applyFlagSettings({skillOverrides})` map so the
   *  switch takes effect on the next assistant turn — no spawn/respawn.
   *
   *  override semantics (see shared/skills.ts):
   *    - undefined / {kind:'inherit'} : follow the global config; flag layer
   *      is cleared (sent as `{}`) so user/project-level settings can win.
   *    - {kind:'mode', mode, allowlist}: pin a specific load mode at the
   *      session scope.
   *    - {kind:'disabled'}            : every skill forced 'off'.
   *
   *  RAM-only by design — see Session.skillOverride for the full reasoning. */
  async setSkillOverride(id: string, override: SessionSkillOverride | undefined): Promise<SessionInfo> {
    const s = this.deps.requireLive(id)
    const next: SessionSkillOverride | undefined =
      !override || override.kind === 'inherit' ? undefined : override
    s.skillOverride = next
    await this.applyDynamicSkillOverrides(s)
    s.lastActivityAt = Date.now()
    this.deps.persist(s)
    return this.deps.info(s)
  }

  /** Read the session's current RAM tool-surface profile. Undefined = inherit
   *  the SDK's / global defaults (create-body passthrough already applied). */
  getToolProfile(id: string): SessionToolProfile | undefined {
    return this.deps.requireLive(id).toolProfile
  }

  /** Pin (or clear, with undefined) the session's tool-surface profile. Tool
   *  surface is spawn-time-only (not a Settings key), so the change takes
   *  effect on the next clear() or fork() respawn — which carry the profile —
   *  not mid-turn. RAM-only like skillOverride: dropped when the live query is
   *  unloaded and a session is resumed from disk. */
  async setToolProfile(id: string, profile: SessionToolProfile | undefined): Promise<SessionInfo> {
    const s = this.deps.requireLive(id)
    s.toolProfile = profile
    s.lastActivityAt = Date.now()
    log.info(`[session ${id}] tool profile set:`, profile)
    return this.deps.info(s)
  }

  /** Send the session's currently-effective skill policy to the SDK via
   *  applyFlagSettings({ skillOverrides: <map> }). The map is built from the
   *  set of skills actually available to this cwd (user + project), so the
   *  flag layer covers every skill explicitly — no ambiguity about which
   *  layer wins for a given skill.
   *
   *  For 'default' mode we deliberately send an empty `{}` rather than
   *  omitting the field: that *replaces* any prior flag-layer overrides
   *  with an empty map (clearing them) so the lower priority layers
   *  (user / project / policy) take effect again. Sending undefined would
   *  leave a previous flag-layer pin in place. */
  async applyDynamicSkillOverrides(s: Session): Promise<void> {
    const policy = this.deps.effectiveSkillPolicyFor(s.skillOverride)
    let availableSkills: string[]
    try {
      const list = await listSkills(s.cwd)
      availableSkills = list.skills.map((skill) => skill.name)
    } catch (err) {
      log.warn(`[session ${s.id}] applyDynamicSkillOverrides: listSkills failed:`, err)
      availableSkills = []
    }
    const map = policyToDynamicSkillOverrides(policy, availableSkills)
    const skillOverrides = map ?? {}
    await this.deps.requireHandleMethod<(settings: Record<string, unknown>) => Promise<void>>(
      s,
      'applyFlagSettings',
      'skill overrides',
    )({ skillOverrides })
  }

  /** Re-broadcast the global skill policy to every live session that's
   *  currently inheriting it. Called from the /api/config save path so a
   *  user toggling the global mode in Settings sees it land in every open
   *  session immediately, without requiring a restart. Sessions that opted
   *  into a session-level override are deliberately unaffected — their
   *  override is "stickier" than the global toggle, that's the whole point.
   *
   *  Errors are collected per-session so one wedged subprocess can't block
   *  the others; the caller (route layer) returns a summary. */
  async reapplyGlobalSkillsToInheritingSessions(): Promise<{
    applied: string[]
    failed: { id: string; error: string }[]
  }> {
    const applied: string[] = []
    const failed: { id: string; error: string }[] = []
    for (const s of this.deps.sessions.values()) {
      if (!s.running || s.terminated) continue
      if (s.skillOverride && s.skillOverride.kind !== 'inherit') continue
      if (typeof s.handle.applyFlagSettings !== 'function') continue
      try {
        await this.applyDynamicSkillOverrides(s)
        applied.push(s.id)
      } catch (err) {
        failed.push({ id: s.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { applied, failed }
  }
}
