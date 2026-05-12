export function notificationTooltip(
  permission: 'granted' | 'denied' | 'default' | 'unsupported',
  enabled: boolean,
): string {
  if (permission === 'unsupported') return 'Browser does not support desktop notifications'
  if (permission === 'denied') return 'Notifications blocked in browser settings'
  if (enabled) return 'Desktop notifications: on · click to disable'
  return 'Desktop notifications: off · click to enable'
}
