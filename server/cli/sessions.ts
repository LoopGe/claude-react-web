import { SessionStore } from '../persistence.js'
import { SessionManager } from '../session-manager.js'
import { CliContext, CliError, CliGroup } from './types.js'
import { ParsedOptions } from './parser.js'
import { table } from './render.js'

async function buildManager(ctx: CliContext): Promise<SessionManager> {
  const store = new SessionStore({ stateDir: ctx.stateDir })
  await store.load()
  return new SessionManager({ store, stateDir: ctx.stateDir })
}

interface SessionShape {
  id: string
  title?: string
  model?: string
  cwd?: string
  messageCount: number
}

async function list(ctx: CliContext): Promise<unknown> {
  const sm = await buildManager(ctx)
  const sessions = sm.list().map((s) => ({
    id: s.id,
    title: s.title,
    model: s.model,
    cwd: s.cwd,
    messageCount: s.messageCount,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
  }))
  sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return { sessions }
}

async function del(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const id = p.positionals[0]
  if (!p.yes) throw new CliError(`destructive: pass --yes to delete session ${id}`, 2)
  const store = new SessionStore({ stateDir: ctx.stateDir })
  await store.load()
  const sm = new SessionManager({ store, stateDir: ctx.stateDir })
  const exists = sm.list().some((s) => s.id === id)
  if (!exists) throw new CliError(`session not found: ${id}`, 1)
  await sm.delete(id)
  // sm.delete() only schedules the store's debounced flush; make the removal
  // durable before the process exits.
  await store.flush()
  return { ok: true, deleted: id }
}

export const sessionsGroup: CliGroup = {
  name: 'sessions',
  summary: 'List and delete persisted sessions',
  subcommands: [
    {
      name: 'list',
      usage: 'sessions list',
      description: 'List sessions (live + persisted).',
      parseSpec: {},
      run: (ctx) => list(ctx),
      render: (d) => {
        const r = d as { sessions: SessionShape[] }
        return table(['id', 'title', 'model', 'cwd', 'messages'],
          r.sessions.map((s) => [s.id, s.title ?? '', s.model ?? '', s.cwd ?? '', String(s.messageCount)]))
      },
    },
    {
      name: 'delete',
      usage: 'sessions delete <id> --yes',
      description: 'Delete a session.',
      parseSpec: { minPositional: 1, maxPositional: 1 },
      run: (ctx, p) => del(ctx, p),
      render: (d) => `deleted session ${(d as { deleted: string }).deleted}`,
    },
  ],
}
