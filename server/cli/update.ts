import { checkForUpdates } from '../update-checker.js'
import { CliGroup } from './types.js'

type UpdateInfo = Awaited<ReturnType<typeof checkForUpdates>>

async function run(): Promise<UpdateInfo> {
  return checkForUpdates()
}

export const updateGroup: CliGroup = {
  name: 'update',
  summary: 'Check for a newer claude-react-web release',
  subcommands: [],
  default: {
    usage: 'update',
    description: 'Check the configured npm registry for a newer version.',
    parseSpec: {},
    run: async () => run(),
    render: (d) => {
      const u = d as UpdateInfo
      if (u.disabled) return 'update check is disabled (no registry configured).'
      if (u.hasUpdate && u.latest) return `update available: ${u.current} → ${u.latest}\nrun: npx claude-react-web@latest`
      return `up to date (${u.current}).`
    },
  },
}
