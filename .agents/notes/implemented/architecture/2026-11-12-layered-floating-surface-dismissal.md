# Agent Note: Layered floating-surface dismissal

Status: implemented

## Problem

A right-click focuses its session trigger, and `HoverPopover` then treats that focus as a reason to ignore pointer-leave closure. The hover and context menu remain open together. A sidebar-only `isContextMenuOpen` prop fixed one card but not header tabs or group chips, and adding equivalent props to every current and future surface would keep the underlying coordination defect.

The existing Escape stack, ContextMenu-only registry, independent hover dwells, and bespoke overlay implementations also could not arbitrate across surface families. A global one-overlay-only rule was not viable: dialogs own nested pickers and confirmations, panel overlays may coexist, and ProfileSwitcher intentionally keeps its menu behind a sibling confirmation dialog.

## Decision

`src/hooks/floating-surface-registry.ts` is the single lifecycle registry for transient floating surfaces. Shared primitives register once with semantic kind, policy phase, container, logical parent, and separate policy/Escape callbacks. `useFloatingSurface` and `FloatingSurfaceProvider` preserve React ancestry across portals; optional `parentId` metadata covers sibling-owned workflows without guessing from focus or DOM proximity.

The semantic tiers are tooltip 0, popover 1, menu 2, and dialog 3. A higher-tier opening dismisses unrelated lower-tier surfaces. Tooltips and unrelated menus replace their peers; same-tier popovers and dialogs may coexist. Registered ancestors and descendants are exempt, and branch dismissal is child-first. ProfileSwitcher passes its menu surface id to its confirmation dialog, so cancelling the dialog returns to the still-open menu.

Hover admission uses actual interactive-container containment. Background hover is denied while an interactive surface is active, but controls inside open surfaces keep hover. Pending attempts from both `HoverPopover` and `ContextOrb` register when armed, allowing an interactive opening to cancel the real timer. Opening and closing a surface before the dwell expires cannot resurrect an old attempt; fresh pointer or focus interaction is required.

Policy-active and Escape/focus-active lifetimes are separate. Motion primitives derive policy phase from `useIsPresent`, while CSS primitives use their actual open/exiting state. Exiting surfaces immediately stop layered arbitration and hover blocking, but retain Escape/focus behavior only where their previous contract requires it. Ordinary close and exit also cancel pending hovers owned by the retiring branch. Escape first selects the branch with the most recent activity, then ranks logical depth within that branch; unrelated branches retain LIFO even when an older branch contains nested surfaces.

Policy dismissal carries `layer`, `replacement`, or `layout` as a reason so close callbacks can avoid user-style focus restoration. Right-click menus still do not autofocus, and layout-shift dismissal remains scoped to the original ContextMenu family. The sidebar-specific prop, the old Escape adapter, the separate ContextMenu Set, and the CSS-only Tooltip were removed. The remaining legacy hints use `HoverHint`.

## Alternatives considered

- **Per-component menu-open props:** rejected because each new surface would need another wired condition and would still not cancel pending hovers or coordinate other surface families.
- **A parallel hover/menu registry:** rejected because Escape ownership, focus traps, and menu ordering would then have competing sources of truth.
- **A global one-overlay-only rule:** rejected because nested dialogs, pickers, and intentional multi-panel overlays are valid.
- **Ownership inferred from `document.activeElement` or DOM proximity:** rejected because portals and right-click focus make ownership ambiguous, and sibling surfaces can share one workflow without sharing DOM ancestry.
- **A global interaction epoch:** rejected during review in favor of registering pending hover attempts directly. Cancellation targets the actual timer and does not depend on a coarse generation counter.
- **Adopting an external overlay library or redesigning z-index tiers:** rejected as unrelated to the lifecycle defect and unnecessarily disruptive to existing focus, Motion, and CSS contracts.

## Consequences

New shared primitives inherit dismissal, nesting, hover admission, and menu replacement by supplying lifecycle metadata rather than implementing local exceptions. Same-tier popovers and dialogs deliberately remain able to coexist, so the policy is not a general modal manager. Sibling-owned workflows must provide explicit `parentId` metadata when React context alone cannot express the relationship.

The migration touched all transient primitive families and made their dismissal reasons and exit phases explicit. Legacy CSS hints now accept HoverPopover's 200/150 ms timing. Primitive string hints use `aria-description` before the visual dwell and hand off to `aria-describedby` only while the tooltip is mounted; rich hover content is never duplicated into a hidden pre-dwell tree. SideChat policy dismissal collapses rather than deletes its session. These constraints are the cost of keeping one registry without changing business-owned open state or visual stacking.

## Verification

Registry and mixed-primitive tests cover the tier matrix, ancestry, pending cancellation, policy dismissal reasons, real AnimatePresence exit, nested Escape, and single registration. Application regressions cover the original sidebar/header conflict, Profile confirmation cancellation, searchable-picker focus behavior, and plugin surfaces. Chromium tests cover real right-click event order, pending open/close races, Motion exit, dialog-internal hover, nested Escape, ContextOrb dwell/focus, and textarea focus/selection preservation. Actual app verification also covers Profile menu → confirmation → cancel using mocked profile/session responses.
