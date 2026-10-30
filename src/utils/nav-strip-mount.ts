// Mount decision for the header's full-session nav strip (SessionNavStrip).
//
// The strip is a permanent header surface on desktop hosts without a custom
// titlebar (browser, Linux desktop): every session/group stays reachable from
// the header whether the sidebar is collapsed or expanded. The sidebar's
// collapsed state is deliberately NOT an input — it used to gate the strip,
// which meant expanding the sidebar made the header tabs disappear.
//
// Custom-titlebar desktop hosts (win/darwin Electron) never mount the strip:
// their titlebar owns the header with always-visible open-panel tabs
// (DesktopTitlebarTabs) instead — no double strip. Mobile never mounts it
// either: the drawer sidebar owns session navigation there.

export interface NavStripMountInput {
  isMobile: boolean
  /** The sidebar's collapsed state. Accepted so the "never gates the strip"
   *  contract is explicit at every call site — the decision ignores it. */
  sidebarCollapsed: boolean
  customTitlebar: boolean
}

export function navStripMounted(input: NavStripMountInput): boolean {
  return !input.isMobile && !input.customTitlebar
}
