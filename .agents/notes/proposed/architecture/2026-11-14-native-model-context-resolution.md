# Agent Note: Native model context resolution

Status: proposed

## Problem

Native context usage currently assumes every model route has a 200K window. That makes auto-compact too early for larger models and too late for smaller ones. A model-name table would still be wrong when identical ids are served by different profiles or gateways.

## Proposal

Resolve capacity for the exact `{profile, baseUrl, model}` route through a provider-owned resolver. An exact per-profile `modelContextWindows[model]` override wins; otherwise the current transport's discovery strategy may supply a positive `max_input_tokens`; an unconfirmed route falls back to 200K. Confirmed values may be larger or smaller than 200K.

The resolver is provider-neutral even though the only current request transport is Anthropic Messages-compatible. Future transports must provide their own discovery strategy or rely on overrides; the app must not interpret another protocol's listing by analogy. This proposal does not implement those transports.

Capacity is derived configuration/runtime metadata, not a durable session event. Resume and fork restore the route and resolve again. Native auto-compact consumes the resolved threshold, retains explicit `autoCompactWindow` precedence, and reserves the existing request output cap. The full contract is in [the design document](../../../../docs/superpowers/specs/2026-11-14-native-context-window-design.md).

## Alternatives considered

- **Keep a static model table.** It cannot represent gateway-specific or dynamic models and would become stale.
- **Use only Models API discovery.** Compatible gateways may not implement retrieval or may omit capacity; explicit overrides remain necessary.
- **Use only configuration.** It works for unknown routes but burdens users with maintaining every capacity and cannot automatically adopt a confirmed larger window.
- **Make model-list membership authoritative.** DSH deliberately separates exact-route resolution from advisory discovery; unlisted dynamic models must remain sendable.
- **Implement other provider wire protocols in the same project.** That is independent transport work, not a prerequisite for removing the fixed capacity assumption.

## Acceptance criteria

- Context usage and auto-compact follow the current exact route, including model/profile switches and resume/fork.
- Reliable endpoint values above and below 200K are honored; unconfirmed values use the 200K fallback without blocking message sends.
- Overrides never cross profile boundaries, and secrets or response bodies never enter logs or public payloads.
- Stale discovery cannot overwrite a newer model selection, and a smaller new window still presents old-history pressure to the pre-dispatch compaction check.
- No new dependency or non-Anthropic request protocol is introduced by this change.

## Risks

- Gateway metadata may be absent or wrong; explicit overrides and last-good caching mitigate this but cannot prove an endpoint's advertised value is correct.
- A 200K fallback can still be wrong for an unknown route; it is deliberately temporary and non-persistent.
- The change reserves the current output cap for proactive compaction but does not add dynamic output limits, blocking model-switch compaction, or overflow recovery.
