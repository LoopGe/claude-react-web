// Fixture: Declarative — framework verification only.
// A purely declarative plugin: static commands + a setting. The command
// returns a notification using the configured label (read from activate
// params). No Host API calls during executeCommand.

import { setup } from '../../_lib/runtime.mjs'

let label = 'pong'

setup({
  activate: async (params) => {
    if (params?.configuration?.['fixture.declarative.label']) {
      label = params.configuration['fixture.declarative.label']
    }
    return { ok: true }
  },
  deactivate: async () => ({ ok: true }),
  executeCommand: async ({ invocationId }) => ({
    type: 'notification',
    invocationId,
    level: 'info',
    title: 'Fixture',
    content: { kind: 'text', text: label },
  }),
})
