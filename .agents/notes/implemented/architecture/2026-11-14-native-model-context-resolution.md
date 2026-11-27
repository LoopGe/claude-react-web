# Agent Note: Native model context resolution

Status: implemented

## Problem

Native context usage assumed every model route had a 200K window. That compacted larger models too early and smaller ones too late. A model-name table would still be wrong when identical ids were served by different profiles or gateways, and a switch to a smaller window could send old over-window history before the UI accepted a fresh usage snapshot.

## Decision

Capacity resolves for the exact `{profile, baseUrl, model}` route through the provider-owned `NativeModelContextResolver`. An exact per-profile `modelContextWindows[model]` override wins; otherwise the Anthropic Messages-compatible discovery strategy accepts a positive safe-integer `max_input_tokens`; an unconfirmed route falls back to `nativeDefaultContextWindow` (config, default 1M, read live through the config port). Full model ids match exactly, overrides never cross profile boundaries, and confirmed values may be larger or smaller than the fallback. The fallback is a guess by construction, so it is a config field rather than a buried constant: gateways that do not implement the Models API (every route falls back) correct it once for the whole deployment, while per-model overrides stay the precise escape hatch. The 1M default follows the product's gateway-served model family (DSH's route-default precedent, `docs/research/2026-11-25-dsh-context-size.md` §7); the original 200K default compacted 1M-class models served by such gateways at 160K.

Discovery retrieves only the current model object, with a 5-second timeout, 64 KiB response cap, and no redirects. The resolver shares same-route in-flight queries, caches successes for 5 minutes, serves expired last-good values while refreshing, and cools every failure for 30 seconds. Profile object identity and model generations isolate stale configuration and late responses. Discovery failures do not fail message sends; usage-control failures still surface to their caller.

`NativeSession.getContextUsage()` reports raw `totalTokens`, `maxTokens`, `model`, and `autoCompactThreshold`. The threshold is `min(floor(window × nativeAutoCompactRatio), window - 16384)` (ratio config default 0.9) computed on the effective window `min(modelWindow, pin)` — `pin` being the spawn `autoCompactWindow`, the raw model window when no pin is set — with numeric `0` when no proactive threshold can reserve the fixed output cap. `maxTokens` stays the resolved model window. Capacity is derived metadata, not a native session event: resume and fork restore the route and resolve again without adding capacity records to v1/v2 logs.

`SessionManager` owns compaction. The provider threshold (including `0`) is the single writer of the effective threshold; the legacy ratio applies only for an undefined threshold. Idle native `send()` and `sendContent()` fetch current raw usage before attachment leases and dispatch. The raw pressure path permits `totalTokens > maxTokens`, so down-switch history compacts before the next stream even when the UI parser rejects that reading. Working and queued sends skip the precheck; summary and compact failures are logged and remain fail-open, and send currency is rechecked after the usage await.

Web import replaces the target mapping when the source supplies one. Importing `modelList` or `baseUrl` without a source mapping clears the target's old mapping; importing neither routing field preserves it. The full rationale and wire limits remain in [the design document](../../../../docs/superpowers/specs/2026-11-14-native-context-window-design.md).

## Alternatives considered

- **Keep a static model table.** It cannot represent gateway-specific or dynamic models and would become stale.
- **Use only Models API discovery.** Compatible gateways may not implement retrieval or may omit capacity; explicit overrides remain necessary.
- **Use only configuration.** It works for unknown routes but burdens users with maintaining every capacity and cannot automatically adopt a confirmed larger window.
- **Make model-list membership authoritative.** Exact-route resolution is separate from advisory discovery; unlisted dynamic models remain sendable.
- **Implement other provider wire protocols in the same project.** That is independent transport work, not a prerequisite for removing the fixed capacity assumption.

## Consequences

The current route controls ContextUsage and compaction across model switches, profile generations, resume, and fork. Reliable capacities above and below the fallback are honored, down-switch compaction sees unmodified pressure, and a confirmed zero threshold cannot be replaced by stale positive facts or the ratio fallback.

Unknown routes still use a non-persistent fallback that can be wrong — now the configurable `nativeDefaultContextWindow` (default 1M) instead of a fixed 200K, so a gateway deployment corrects it once rather than per model. The 1M default knowingly trades the old failure direction for the new one: a genuinely 200K model on a route whose discovery fails (a gateway without the Models API, or an official-API route inside the 5s-timeout / 30s-cooldown window) resolves a 5× over-estimate, so proactive compaction is skipped and an over-window request can fail prompt-too-long at the API instead of compacting early. The old 200K fallback had the mirror defect on 1M-class gateway models (compaction at 160K), which is the case this default was chosen for; per-model `modelContextWindows` overrides are the correction for a mixed-capacity deployment. A first uncached discovery can delay an idle send by one bounded 5-second query. The implementation keeps the fixed 16,384-token output reservation and does not add dynamic output limits, blocking model-switch compaction, overflow recovery, or non-Anthropic request protocols. Native does not send the `context-1m` beta header, so a 1M Sonnet window on the official API remains a separate beta-wiring concern, not a fallback concern.
