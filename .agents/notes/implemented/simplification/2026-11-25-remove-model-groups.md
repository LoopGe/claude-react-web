# Agent Note: Remove model groups

Status: implemented

## Problem

Model groups (`modelGroups` / `modelGroupId` / `ModelGroupConfig`) were a
Claude-CLI-shaped feature whose group protocol leaked across the provider seam.
The manager treated a group as a provider-neutral session property, but only the
`claude` provider honored it (tier env vars + alias resolution + fallback chain).
The `native` provider never consumed `modelGroupId`, and the manager's group
control path called `applyFlagSettings({ fallbackModel })` unconditionally — a
key native rejects.

Verified against an isolated server (temp state dir, controlled config where
`modelList[0]` ≠ the group main):

- **Create with a group on native:** the session was tagged with the group
  (`modelGroupId` persisted, picker showed it selected) but actually ran
  `modelList[0]`, never the group's declared main. The manager's spawn-time
  group resolution was overwritten by `syncEffectiveSettings` (provider truth),
  and the provider received the unresolved `fullOpts.model`. Resume did not
  self-heal — the group main was never applied at any lifecycle stage.
- **Live group switch on native:** `POST /sessions/:id/model-group` returned
  **502** (`fallback model failed: native provider does not support flag
  settings: fallbackModel`). The first step (`setModel`) had already applied,
  so the core ran the group main while `session.model` / `modelGroupId` stayed
  unchanged and unpersisted — a half-applied divergence. Switching a group-tagged
  native session back to a single model (`setModel`'s `wasGroup` branch) failed
  the same way.

Root cause: the group protocol had no capability declaration, group→model
resolution had two owners (manager spawn block + claude provider), and the
two-step switch was non-atomic.

## Decision

Delete the feature end-to-end. The user confirmed model groups are not used
going forward. Removing the feature deletes the whole defect class rather than
gating or reimplementing it.

## What was kept (load-bearing)

- The claude provider's four tier env vars (`ANTHROPIC_DEFAULT_OPUS_MODEL` /
  `SONNET` / `HAIKU` / `ANTHROPIC_SMALL_FAST_MODEL`), now always collapsed to the
  session model (the former no-group branch is the only path).
  `mergeTierEnvIntoSettings` stays.
- The aux per-field override path (`recapModel` / `commitMessageModel` /
  `autoClassifierModel`); the fallback is now the session model.
- The model picker's single-model rows, recents, and free-text custom row.
- **Session-group sidebar grouping** (`groups` / `groupId` / `SessionGroup`) —
  a different feature, untouched.

## Migration

Drop-on-read, no destructive migration: the persistence reader ignores a legacy
on-disk `modelGroupId` (model preserved, tag dropped); `loadConfig` ignores a
legacy `modelGroups` key without wiping the profile.

## Alternatives considered

- **Capability-gate groups to claude** (`supportsModelGroups`): keeps the value
  for claude but leaves the duplicated resolution and non-atomic switch in place.
  Rejected because the feature is unused.
- **Implement groups in native**: treats groups as a provider-neutral "model
  bundle"; requires defining native tier semantics. Rejected as unused scope.

`resolveConfiguredModelId` (the shared bare-name resolver in `model-groups.ts`)
turned out to have no production consumer after the removal — the manager uses
its own private `resolveConfiguredModel` — so `model-groups.ts` was deleted
wholesale rather than relocated.

## Consequences

- Users lose the ability to bundle tier models and route background subagents /
  fallback to a cheaper tier; every session and aux call runs one model. This is
  the intended trade — the feature was unused.
- The provider seam is simpler: no group protocol, no `fallbackModel` flag-setting
  path, no duplicated group resolution. The tier env mechanism survives in its
  single-model form.
- Legacy `modelGroups` / `modelGroupId` data is ignored on read, so existing
  configs and sessions keep working without a migration step.

## Verification

Plan: `docs/superpowers/plans/2026-11-25-remove-model-groups.md`. Each task ended
typecheck-green (both tsconfigs) with its tests passing; the full suite + lint
gate the branch. Supersedes
`docs/superpowers/specs/2026-08-27-model-groups-tier-routing-design.md`.