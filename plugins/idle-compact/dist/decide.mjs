// Pure decision logic for idle auto-compact.
//
// Separated from service.mjs so it can be unit-tested without spawning a
// subprocess. `shouldCompact` answers "is this session worth compacting right
// now?" given its activity snapshot + cached context usage + the plugin's
// declared configuration (defaults applied).

/**
 * Should a session be compacted right now?
 *
 * @param {object} input
 * @param {number} input.idleMs          ms since the session's last activity
 * @param {number} input.historyLength   messages in the in-memory history ring
 * @param {object|null} input.usage      cached context usage (sessions.contextUsage result), or null
 * @param {object} input.config          plugin configuration (defaults applied)
 * @returns {boolean}
 */
export function shouldCompact({ idleMs, historyLength, usage, config }) {
  if (!config || typeof config !== 'object') return false
  if (config['idle-compact.claude-react-web.enabled'] === false) return false

  const idleMinutes = config['idle-compact.claude-react-web.idleMinutes'] ?? 10
  const thresholdPercent = config['idle-compact.claude-react-web.thresholdPercent'] ?? 90
  const minHistoryMessages = config['idle-compact.claude-react-web.minHistoryMessages'] ?? 20

  if (typeof idleMs !== 'number' || idleMs < idleMinutes * 60_000) return false
  if (typeof historyLength !== 'number' || historyLength < minHistoryMessages) return false
  if (!usage || typeof usage !== 'object') return false
  if (typeof usage.totalTokens !== 'number' || usage.totalTokens <= 0) return false

  // Prefer the SDK's auto-compact threshold when known: compact when we're at
  // thresholdPercent% of the way to the point the CLI would auto-compact.
  // Fall back to the reported percentage of the context window otherwise.
  const threshold = usage.autoCompactThreshold
  if (typeof threshold === 'number' && threshold > 0) {
    return usage.totalTokens >= threshold * (thresholdPercent / 100)
  }
  if (typeof usage.percentage === 'number') {
    return usage.percentage >= thresholdPercent
  }
  return false
}
