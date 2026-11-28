// The tools that always reach the user, whatever the permission mode says.
//
// `bypassPermissions` auto-allows ordinary tool calls, but two calls are not
// permission checks at all: AskUserQuestion IS the dialog, and ExitPlanMode is
// a plan proposal awaiting review. Bypassing them would silently drop a
// question or start executing an unapproved plan, so the host permission broker
// intercepts both BEFORE its own bypass auto-allow, and providers must not
// short-circuit them either.
//
// Neutral (no imports): shared by the host broker (`server/permission-broker.ts`)
// and the host-free native core (`server/providers/native/native-session.ts`),
// which may not import the broker.

/** Tool names whose calls are routed to a human dialog regardless of mode. */
export const BYPASS_IMMUNE_INTERACTIVE_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
])

/** True when a tool call must reach the user even under bypassPermissions. */
export function isBypassImmuneInteractiveTool(toolName: string): boolean {
  return BYPASS_IMMUNE_INTERACTIVE_TOOLS.has(toolName)
}
