// Neutral frame-identity context for the native provider core (option C
// relocation from the former native/frames.ts, which became adapter-side).
// The core mints live-frame uuids and carries the sidechain parent axis
// through this context; it imports nothing outside the vocabulary, so the
// turn engine never touches the SDK-shaped Frame type the adapter owns.

/** Identity facts every emitted frame carries. `sessionId` is the owning
 *  session; `uuid()` mints a fresh frame id per call; `parentToolUseId` is the
 *  sidechain axis — null for the main thread, the spawning tool_use id for a
 *  nested runner. */
export interface FrameContext {
  sessionId: string
  uuid(): string
  /** Set by a nested (sidechain) runner: the id of the tool_use that spawned
   *  it. Unset / null for the main thread. */
  parentToolUseId?: string | null
}

export function defaultFrameContext(sessionId: string, parentToolUseId?: string | null): FrameContext {
  return { sessionId, uuid: () => crypto.randomUUID(), parentToolUseId: parentToolUseId ?? null }
}
