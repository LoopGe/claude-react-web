// Seam between the HTTP layer and runServer's graceful shutdown closure.
// POST /api/daemon/stop needs to reuse the EXACT shutdown path SIGINT/SIGTERM
// take; the closure lives in server/cli.ts, so it registers itself here.
let handler: (() => Promise<void>) | null = null

export function registerShutdownRequest(fn: (() => Promise<void>) | null): void {
  handler = fn
}

export async function requestShutdown(): Promise<boolean> {
  if (handler == null) return false
  await handler()
  return true
}
