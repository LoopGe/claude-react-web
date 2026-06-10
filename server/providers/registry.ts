import type { AgentProvider } from './types.js'
import { HttpError } from '../errors.js'

export class ProviderRegistry {
  private providers = new Map<string, AgentProvider>()

  register(provider: AgentProvider): void {
    this.providers.set(provider.name, provider)
  }

  get(name = 'claude'): AgentProvider {
    const provider = this.providers.get(name)
    if (!provider) throw new HttpError(400, 'unknown provider: ' + name)
    return provider
  }

  list(): AgentProvider[] {
    return [...this.providers.values()]
  }
}
