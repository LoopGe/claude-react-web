// Display labels for the two built-in session providers. Names mirror the
// server's provider registry (`claude` = the Claude CLI subprocess, `native`
// = the in-process loop). Shared by the session settings panel, the session
// hover card and the New-session dialog so the wording cannot drift.

export const PROVIDER_LABELS = {
  claude: 'Claude CLI',
  native: 'Native in-process',
} as const

export type BuiltinProvider = keyof typeof PROVIDER_LABELS

/** Human label for one session's provider. Undefined / empty (metas persisted
 *  before the field existed) means the server's default — the Claude CLI. An
 *  unrecognised name renders raw rather than pretending to be Claude. */
export function providerLabel(provider: string | undefined): string {
  if (provider == null || provider === '') return PROVIDER_LABELS.claude
  return (PROVIDER_LABELS as Record<string, string>)[provider] ?? provider
}

/** One-line explanation for the settings panel's read-only Provider row. */
export function providerDescription(provider: string | undefined): string {
  if (provider === 'native') {
    return 'Runs in-process against the configured API; no Claude CLI subprocess.'
  }
  if (provider == null || provider === '' || provider === 'claude') {
    return 'Runs the Claude CLI as a subprocess.'
  }
  return `Provider "${provider}" as registered by the server.`
}
