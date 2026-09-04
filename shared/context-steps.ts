/** Anthropic beta flag that enables the 1M-token context window.
 *
 *  On the first-party Anthropic API this beta is documented for Sonnet 4 /
 *  4.5 only; on gateway deployments it is the flag that unlocks 1M for the
 *  configured models. The app sends it on every new session (New Session
 *  dialog) and defaults it on every spawn that carries no betas, so a session
 *  never silently drops back to the model's default 200K window. */
export const ONE_M_CONTEXT_BETA = 'context-1m-2025-08-07'
