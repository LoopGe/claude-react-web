export function notificationTooltip(
  permission: 'granted' | 'denied' | 'default' | 'unsupported',
  enabled: boolean,
): string {
  if (permission === 'unsupported') {
    // The Notification API is gated to secure contexts. When the page is
    // served over plain HTTP from a non-localhost origin (the common case
    // when connecting to a remote host by IP), the browser hides the API
    // entirely — so `unsupported` here usually means "insecure context",
    // not "ancient browser". Surface the actionable reason instead of a
    // dead-end "not supported" message.
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      return 'Notifications need a secure context — open via HTTPS or localhost (e.g. SSH-forward the port)'
    }
    return 'Browser does not support desktop notifications'
  }
  if (permission === 'denied') return 'Notifications blocked in browser settings'
  if (enabled) return 'Desktop notifications: on · click to disable'
  return 'Desktop notifications: off · click to enable'
}
