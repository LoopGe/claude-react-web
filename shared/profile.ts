// Provider profile shapes: the neutral type definitions behind the host
// config layer and the providers. This module imports nothing, so it is safe
// to import from both host and host-free code.

/** A named subscription bundle. `modelList[0]` is the profile's default
 *  model. authToken is the Anthropic/gateway API key (NOT the web access
 *  token). */
export interface ProviderProfile {
  id: string
  name: string
  authToken: string
  baseUrl: string
  modelList: readonly string[]
  /** Exact request model id → context capacity. No cross-profile inheritance. */
  modelContextWindows?: Readonly<Record<string, number>>
  /** Model for AI session recaps. EMPTY = use the session's own model.
   *  Never a hardcoded default: a model id this profile's provider does not
   *  serve is rejected at request time (third-party gateways answer 401 for
   *  an unroutable model), so "unset" has to stay expressible. */
  recapModel: string
  /** Model for AI-generated commit messages. EMPTY = use the session's own
   *  model. See recapModel. */
  commitMessageModel: string
}
