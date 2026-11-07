// Plan the MCP server list for attaching / detaching one global server on a
// session. Pure: the SessionMcpManager resolves the inputs and applies the
// plan, so the idempotence and stamping rules are unit-testable on their own.
//
// Two session shapes exist. A session with an explicit `mcpServerNames` list
// owns its set, so every mutation must re-stamp it (otherwise a later spawn
// would fall back to the global set). A session without the list inherits the
// global enabled set, so attaching must not pin it to a snapshot of today's
// globals — the plan only reports the set to send to the SDK.
//
// `alreadyAttached` keys on the LIVE runtime names, never on global
// membership: a globally enabled server added after the session spawned is
// not connected to it yet and still needs an attach.

export interface AttachPlanInput {
  /** `undefined` = the session inherits the global enabled set. */
  sessionNames: string[] | undefined
  /** Names currently live on the session (`Object.keys(dynamicMcpServers ?? {})`). */
  runtimeNames: string[]
  globalEnabledNames: string[]
  name: string
}

export interface AttachPlan {
  names: string[]
  stampNames: boolean
  alreadyAttached: boolean
}

export function planAttachGlobalMcpServer(input: AttachPlanInput): AttachPlan {
  const base = input.sessionNames ?? input.globalEnabledNames
  return {
    names: [...new Set([...base, input.name])],
    stampNames: input.sessionNames !== undefined,
    alreadyAttached: input.runtimeNames.includes(input.name),
  }
}

export function planDetachGlobalMcpServer(input: AttachPlanInput): AttachPlan {
  const base = input.sessionNames ?? input.globalEnabledNames
  return {
    names: [...new Set(base.filter((n) => n !== input.name))],
    stampNames: input.sessionNames !== undefined,
    alreadyAttached: input.runtimeNames.includes(input.name),
  }
}
