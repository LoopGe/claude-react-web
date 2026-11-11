# Agent Note: Native agent profile presets

Status: implemented

## Problem

Native sessions accepted a main-thread agent name and custom nested agent definitions without applying most of their behavior fields. A selected persona could therefore differ from the model, tools, skills, permission mode, effort, and turn budget actually used. Persisting only the name also made resume and fork sensitive to later definition edits, while clearing a persona risked retaining effective overrides or losing the session's original tool policy.

The design needs one profile implementation for main and nested execution without changing the existing synchronous, depth-one Agent protocol. It also needs live switching between turns, deterministic recovery from the native log, and an explicit migration path for legacy metadata that names unsupported definitions.

## Decision

A shared `NativeAgentProfile` parser handles `prompt`, `model`, `tools`, `disallowedTools`, `mcpServers`, `skills`, `permissionMode`, `maxTurns`, and string `effort` for both main and nested agents. New create and switch operations reject unsupported fields by name. Tool filtering runs over a freshly rebuilt builtin and MCP snapshot in allowlist, denylist, then server-scope order. Skill profiles are scoped views over the shared discovery cache.

The main session separates base configuration from next-turn effective configuration. Persona fields override individual base fields without rewriting them. Model, permission, effort, and tool-profile controls update the base and refresh effective values only when the persona does not pin the field. `SessionInfo` and the permission broker expose the effective values; clearing the persona restores the latest base values.

A history-only `session/agent` event stores the selected name, a full definition snapshot, and the base snapshot, including `base.toolProfile`. The event does not enter model history, the UI transcript, or search. Resume and fork read the latest event in their retained log prefix instead of resolving the current store definition. Compact does not erase the selection. Base-control changes append a fresh event with the current definition so resume followed by clear cannot restore an older base.

Nested agents start from the current full builtin and MCP snapshot with only the session's `baseToolProfile` applied, then apply their own profile. The parent persona does not narrow the nested snapshot, while the base session's explicit tool restrictions remain an upper bound. Nested permission mode rides the `canUseTool` context and overrides broker evaluation for that call without changing the parent session. The nested runner retains fresh sidechain history, one final tool result, depth one, and existing background-detach behavior.

Fresh create validates the definition before opening a log and writes context plus the initial selection in one synchronous seed. Runtime selection changes use `appendDurable` and update effective state only after the durable reservation succeeds. On a genuine write failure, the owning writer rolls back to its pre-reservation size and restores ordinary events with contiguous sequence numbers; a superseded writer never truncates its replacement, and close owns restored bytes when a write failure races shutdown. Legacy migration uses the constructor-safe synchronous append plus background flush path.

A legacy log with no selection event and a supported `SessionMeta.agent` gains a full snapshot. An unsupported legacy definition produces an explicit clear event with `droppedAgent`, clears the manager's agent metadata, and emits an informational warning listing every unsupported field. No partial persona is applied. Restart carries the agent name into a fresh session, where the current definition is resolved deliberately.

## Alternatives considered

- **DSH's blank-session preset lock.** This loses because the application already exposes live agent switching for Claude. Native selections take effect on the next turn and are durable before that turn's first request; an in-flight turn keeps its starting profile.
- **Cordis composition and independent child sessions.** This loses because Stage A needs profile correctness, not a plugin runtime or continuable child-session architecture. The existing synchronous native Agent runner already owns the required parentage, result, and lifecycle behavior.
- **Intersecting nested tools with the parent's effective tools.** This loses because the parent persona and nested profile are independent compositions. A restrictive parent persona must not silently erase a nested agent's declared tools. Only the pre-persona `baseToolProfile` constrains both.
- **Applying the supported subset of a legacy persona.** This loses because a stripped persona misrepresents the user's selected definition and can change tool or permission behavior without a visible decision. Legacy recovery uses a plain session plus a durable drop record and warning instead.
- **Transcript messages or a second configuration sidecar for selection state.** This loses because persona selection is neither model conversation nor renderable transcript content. A history-only event in the native log keeps recovery, fork cuts, and model replay on one ordered source.

## Consequences

The log stores definition and base snapshots on selection and subsequent base-control changes, trading some event volume for deterministic recovery and fork behavior. Live switching intentionally differs from DSH's blank-only rule. Effective settings can differ from base settings while a persona is active, so provider controls, manager metadata, and broker evaluation must stay synchronized through the provider's effective-settings read.

The implementation does not provide subagent descriptors, independent subagent transcript views, Task or Explore roles, forked Skills, plugin skills, `session/skill`, continuable child sessions, or multi-level delegation. Those remain Stage B/C or independent follow-up work. Unsupported advanced agent fields remain explicit errors for new selections, while legacy sessions choose visible degradation over a resume failure.
