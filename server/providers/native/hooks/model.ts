// server/providers/native/hooks/model.ts

/** Default small-fast model id for prompt/agent hooks (controller ruling —
 *  configurable). The CLI's `Mb()` = ANTHROPIC_SMALL_FAST_MODEL else a
 *  Haiku-class small-fast model (RS §6). `server/config.ts` reads no
 *  process.env, so the caller passes the config/profile small-fast value as
 *  `smallFastEnv`; this constant is the fallback when neither that nor a
 *  per-hook model is set. It is deliberately NOT the session main model. */
export const DEFAULT_SMALL_FAST_MODEL = 'claude-haiku-5-5'

export interface HookModelOptions {
  /** Per-hook `model` field (PromptHookConfig/AgentHookConfig.model). Wins. */
  configured?: string
  /** Config/profile small-fast model (the CLI's ANTHROPIC_SMALL_FAST_MODEL). */
  smallFastEnv?: string
  /** Session main model — the agent gateway-fallback target. */
  sessionModel: string
  /** True ONLY for an AGENT hook on a gateway transport: the caller computes
   *  `type === 'agent' && isGateway`. Prompt hooks never set it (RS §6.1 has no
   *  gateway fallback; only the agent loop §6.2 does). */
  gateway: boolean
}

/** Resolve the model for a prompt/agent hook (RS §6):
 *  `configured ?? smallFastEnv ?? (gateway ? sessionModel : DEFAULT_SMALL_FAST_MODEL)`.
 *
 *  The per-hook model wins outright. Otherwise the small-fast env/config value
 *  is used. The agent gateway fallback to the session main model fires ONLY
 *  when no small-fast is configured (agent on a gateway without the
 *  haiku/small-fast env, RS §6.2 `dc(y)`); a present smallFastEnv beats it.
 *  Absent all of those, the Haiku-class default — never the session main model
 *  on the non-gateway path. Neutral: no imports. */
export function resolveHookModel(opts: HookModelOptions): string {
  return (
    opts.configured ??
    opts.smallFastEnv ??
    (opts.gateway ? opts.sessionModel : DEFAULT_SMALL_FAST_MODEL)
  )
}
