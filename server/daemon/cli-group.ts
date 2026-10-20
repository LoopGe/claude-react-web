// `claude-react-web daemon` command group. Thin over daemon/ops.ts — the CLI
// is one of the two surfaces (with /api/daemon) onto the same semantics.
import type { CliGroup, Subcommand } from '../cli/types.js'
import type { ParsedOptions } from '../cli/parser.js'
import { daemonStatus, daemonEnable, daemonDisable, daemonStopAll, daemonStopBySignal, daemonRequestStart } from './ops.js'

type RunCtx = { stateDir: string }

function sub(
  name: string,
  usage: string,
  description: string,
  run: (ctx: RunCtx, parsed: ParsedOptions) => Promise<unknown>,
  render: (data: unknown) => string,
): Subcommand {
  return { name, usage, description, parseSpec: {}, run, render, exitCode: () => 0 }
}

export const daemonGroup: CliGroup = {
  name: 'daemon',
  summary: 'Manage login auto-start (runs the server supervised in the background).',
  subcommands: [
    sub('install', 'daemon install', 'Register OS auto-start and start the daemon now',
      async (ctx) => {
        const snap = await daemonEnable(ctx.stateDir)
        await daemonRequestStart(ctx.stateDir)
        return snap
      },
      (d) => `Auto-start registered via ${(d as { mechanism: string }).mechanism}; daemon started.`),
    sub('uninstall', 'daemon uninstall', 'Unregister auto-start AND stop the daemon and server',
      async (ctx) => {
        const snap = await daemonDisable(ctx.stateDir)
        await daemonStopAll(ctx.stateDir)
        return snap
      },
      () => 'Auto-start unregistered; daemon and server stopping.'),
    sub('status', 'daemon status', 'Show auto-start registration and daemon/server state',
      async (ctx) => daemonStatus(ctx.stateDir),
      (d) => {
        const s = d as { configEnabled: boolean; osRegistered: boolean; daemonAlive: boolean; drift: boolean; mechanism: string; child: { state: string; restartCount: number } | null }
        const lines = [
          `mechanism: ${s.mechanism}`,
          `config autoStart: ${s.configEnabled}`,
          `OS registered: ${s.osRegistered}`,
          `daemon alive: ${s.daemonAlive}`,
          `child: ${s.child ? `${s.child.state} (restarts: ${s.child.restartCount})` : 'none'}`,
        ]
        if (s.drift) lines.push('DRIFT: config says on but registration is missing — run `daemon install` to re-register.')
        return lines.join('\n')
      }),
    sub('start', 'daemon start', 'Start the daemon now (no-op if already running)',
      async (ctx) => daemonRequestStart(ctx.stateDir),
      (d) => {
        const started = (d as { started: string }).started
        return started === 'already-running' ? 'daemon already running.' : `daemon start requested (${started}).`
      }),
    sub('stop', 'daemon stop', 'Stop the supervised server (the daemon keeps running)',
      async (ctx) => { await daemonStopBySignal(ctx.stateDir); return { stopped: true } },
      () => 'Stop requested — the supervisor will not restart this server.'),
  ],
}
