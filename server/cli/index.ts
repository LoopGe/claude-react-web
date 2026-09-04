import { CliContext, CliError, CliGroup } from './types.js'
import { parseArgs } from './parser.js'
import { fmtJson } from './render.js'
import { mcpGroup } from './mcp.js'
import { marketplaceGroup } from './marketplace.js'
import { appPluginGroup } from './app-plugin.js'
import { configGroup } from './config.js'
import { sessionsGroup } from './sessions.js'
import { doctorGroup } from './doctor.js'
import { updateGroup } from './update.js'

export const GROUPS: CliGroup[] = [
  mcpGroup,
  marketplaceGroup,
  appPluginGroup,
  configGroup,
  sessionsGroup,
  doctorGroup,
  updateGroup,
]

export function topLevelHelp(): string {
  return (
    'Usage: claude-react-web [server options] [command]\n\n' +
    'Run without a command to start the web server. Server options:\n' +
    '  run `claude-react-web --help` (server) for the full flag list.\n\n' +
    'Commands:\n' +
    GROUPS.map((g) => `  ${g.name.padEnd(14)} ${g.summary}`).join('\n')
  )
}

function groupHelp(g: CliGroup): string {
  const subs = g.subcommands.length
    ? '\n\nCommands:\n' + g.subcommands.map((s) => `  ${s.name.padEnd(10)} ${s.usage} — ${s.description}`).join('\n')
    : ''
  return `Usage: claude-react-web ${g.default ? g.default.usage : `${g.name} <command>`}\n\n${g.summary}${subs}`
}

export async function runCliCommand(ctx: CliContext, groupName: string, argv: string[]): Promise<number> {
  const group = GROUPS.find((g) => g.name === groupName)
  if (!group) throw new CliError(`unknown command: ${groupName}`, 2)

  if (group.default && (argv.length === 0 || argv[0].startsWith('-'))) {
    const parsed = parseArgs(argv, group.default.parseSpec)
    if (parsed.help) {
      console.log(`Usage: claude-react-web ${group.default.usage}\n\n${group.default.description}`)
      return 0
    }
    const data = await group.default.run(ctx, parsed)
    console.log(parsed.json ? fmtJson(data) : group.default.render(data))
    return group.default.exitCode?.(data) ?? 0
  }

  const verb = argv[0]
  if (verb === undefined || verb === 'help' || verb === '--help' || verb === '-h') {
    console.log(groupHelp(group))
    return 0
  }
  const sub = group.subcommands.find((s) => s.name === verb)
  if (!sub) throw new CliError(`unknown ${group.name} subcommand: ${verb}`, 2)
  const parsed = parseArgs(argv.slice(1), sub.parseSpec)
  if (parsed.help) {
    console.log(`Usage: claude-react-web ${group.name} ${sub.usage}\n\n${sub.description}`)
    return 0
  }
  const data = await sub.run(ctx, parsed)
  console.log(parsed.json ? fmtJson(data) : sub.render(data))
  return sub.exitCode?.(data) ?? 0
}
