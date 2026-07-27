// Fixture: Service — framework verification only.
// - fixture.service.store: round-trips a value through the storage Host API.
// - fixture.service.crash: exits the subprocess (exercises crash quarantine).

import { setup } from '../../_lib/runtime.mjs'

setup({
  activate: async () => ({ ok: true }),
  deactivate: async () => ({ ok: true }),
  executeCommand: async ({ invocationId, commandId, context }) => {
    if (commandId === 'fixture.service.crash') {
      process.exit(1)
    }
    // store: set then get, echo the value back.
    await globalThis.__callHost('storage.set', { scope: 'global', key: 'fixture', value: 'roundtripped' })
    const got = await globalThis.__callHost('storage.get', { scope: 'global', key: 'fixture' })
    return {
      type: 'notification',
      invocationId,
      level: 'success',
      content: { kind: 'text', text: `storage round-trip: ${got?.value ?? '(missing)'}` },
    }
  },
})
