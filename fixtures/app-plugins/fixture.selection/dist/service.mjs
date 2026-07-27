// Fixture: Selection — framework verification only.
// Returns a fixed Popover echoing the selected text. No translation, no
// network, no business logic.

import { setup } from '../../_lib/runtime.mjs'

setup({
  activate: async () => ({ ok: true }),
  deactivate: async () => ({ ok: true }),
  executeCommand: async ({ invocationId, context }) => {
    const text = context?.selection?.text ?? '(no selection)'
    return {
      type: 'popover',
      invocationId,
      title: 'Selection (fixture)',
      content: { kind: 'text', text: `You selected: ${text}` },
    }
  },
})
