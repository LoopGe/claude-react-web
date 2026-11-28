// server/providers/native/e2e-worktree.test.ts
//
// Acceptance coverage for EnterWorktree/ExitWorktree at the SESSION level:
// the next tool call in the SAME turn runs inside the created worktree (the
// loop's cwd is a live getter, not a spawn-time snapshot), a resumed session
// re-enters the worktree its transcript claims (the client chip and the model
// history must never disagree with where edits land), and ExitWorktree keep
// returns to the launch directory. Real git runs against a temp repository;
// the git write is the feature, so faking the port would test nothing.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from '../../git.js'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { ProviderRegistry } from '../registry.js'
import { makeNativePorts } from '../native-host-adapters.js'
import type { CanonicalEvent } from './canonical.js'
import { NativeProvider } from './native-provider.js'

type Frame = Record<string, any>
type StreamRequest = {
  tools: Array<{ name: string }>
  messages: Array<{ role: string; content: unknown }>
  signal: AbortSignal
}
type StreamHandler = (req: StreamRequest, round: number) => CanonicalEvent[]

const managers: SessionManager[] = []
const sessionIds: Array<{ sm: SessionManager; id: string }> = []
const dirs: string[] = []

function textTurn(text: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

function toolUseTurn(id: string, name: string, input: Record<string, unknown>): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id, name } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify(input) } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

function allowingCanUseTool(): NonNullable<Parameters<SessionManager['create']>[0]['canUseTool']> {
  const handler = async (_name: string, input: Record<string, unknown>) => ({
    behavior: 'allow' as const,
    updatedInput: input,
  })
  return handler as unknown as NonNullable<Parameters<SessionManager['create']>[0]['canUseTool']>
}

async function makeFixture(stateDir: string): Promise<{ sm: SessionManager; store: SessionStore; requests: StreamRequest[]; setStream(handler: StreamHandler): void }> {
  const store = new SessionStore({ stateDir })
  await store.load()
  const provider = new NativeProvider({ stateDir, ports: makeNativePorts({ stateDir }) })
  const requests: StreamRequest[] = []
  let handler: StreamHandler = () => textTurn('unscripted response')
  provider._testStream = (async function* (req: StreamRequest) {
    requests.push({ tools: req.tools, messages: structuredClone(req.messages), signal: req.signal })
    for (const event of handler(req, requests.length)) yield event
  }) as unknown as NativeProvider['_testStream']
  const registry = new ProviderRegistry()
  registry.register(provider)
  const sm = new SessionManager({ store, providers: registry })
  managers.push(sm)
  return { sm, store, requests, setStream: (next) => { handler = next } }
}

async function makeRepo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'native-worktree-e2e-')))
  dirs.push(dir)
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 'test@example.com'])
  await runGit(dir, ['config', 'user.name', 'Test'])
  await writeFile(join(dir, 'README.md'), 'launch checkout\n')
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

async function createSession(sm: SessionManager, cwd: string): Promise<string> {
  const info = await sm.create({
    cwd,
    model: 'test-model',
    provider: 'native',
    title: 'worktree',
    canUseTool: allowingCanUseTool(),
  })
  sessionIds.push({ sm, id: info.id })
  return info.id
}

function collectFrames(sm: SessionManager, id: string): { frames: Frame[]; unsubscribe(): void } {
  const sub = sm.subscribe(id)
  const frames: Frame[] = []
  void (async () => {
    for await (const frame of sub.iterable) frames.push(frame as Frame)
  })()
  return { frames, unsubscribe: () => sub.unsubscribe() }
}

function topLevelResults(frames: Frame[]): Frame[] {
  return frames.filter((frame) => frame.type === 'result' && frame.parent_tool_use_id == null)
}

function toolResultText(frames: Frame[], toolUseId: string): string {
  return frames.flatMap((frame) => {
    if (frame.type !== 'user' || !Array.isArray(frame.message?.content)) return []
    return frame.message.content
      .filter((block: Record<string, unknown>) => block.type === 'tool_result' && block.tool_use_id === toolUseId)
      .map((block: Record<string, unknown>) => {
        const content = block.content
        if (typeof content === 'string') return content
        return Array.isArray(content)
          ? content.filter((part: Record<string, unknown>) => part.type === 'text').map((part: Record<string, unknown>) => part.text).join('')
          : ''
      })
  }).join('')
}

async function sendAndSettle(sm: SessionManager, id: string, text: string, frameBox: { frames: Frame[] }): Promise<void> {
  await sm.send(id, text)
  await vi.waitFor(() => expect(topLevelResults(frameBox.frames)).toHaveLength(1), { timeout: 8000 })
}

const worktreeOf = (repo: string, name: string) => join(repo, '.claude', 'worktrees', name)

afterEach(async () => {
  for (const { sm, id } of sessionIds) {
    try { await sm.delete(id) } catch { /* already removed by shutdown */ }
  }
  sessionIds.length = 0
  for (const sm of managers) await sm.shutdown()
  managers.length = 0
  await new Promise((resolve) => setTimeout(resolve, 80))
  for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs.length = 0
})

describe('native worktree isolation end to end', () => {
  it('runs the very next tool call inside the entered worktree, in the same turn', async () => {
    const repo = await makeRepo()
    const stateDir = await mkdtemp(join(tmpdir(), 'native-worktree-state-'))
    dirs.push(stateDir)
    const fx = await makeFixture(stateDir)
    fx.setStream((_req, round) => {
      if (round === 1) return toolUseTurn('tu-enter', 'EnterWorktree', { name: 'iso' })
      if (round === 2) return toolUseTurn('tu-pwd', 'Bash', { command: 'pwd' })
      return textTurn('done')
    })
    const id = await createSession(fx.sm, repo)
    const box = collectFrames(fx.sm, id)

    await sendAndSettle(fx.sm, id, 'isolate and check pwd', box)

    const enterResult = toolResultText(box.frames, 'tu-enter')
    expect(enterResult).toContain(`Created worktree at “${worktreeOf(repo, 'iso')}” on branch “worktree-iso”.`)
    // The same turn's NEXT tool ran in the worktree: the live dashed cwd.
    expect(toolResultText(box.frames, 'tu-pwd')).toContain(worktreeOf(repo, 'iso'))
    // And the worktree is a real checkout of HEAD.
    await expect(runGit(worktreeOf(repo, 'iso'), ['rev-parse', '--abbrev-ref', 'HEAD'])).resolves.toMatchObject({ stdout: expect.stringContaining('worktree-iso') })
    box.unsubscribe()
  })

  it('re-enters the worktree on resume, so edits never land in the launch checkout', async () => {
    const repo = await makeRepo()
    const stateDir = await mkdtemp(join(tmpdir(), 'native-worktree-resume-state-'))
    dirs.push(stateDir)
    const first = await makeFixture(stateDir)
    first.setStream((_req, round) => {
      if (round === 1) return toolUseTurn('tu-enter', 'EnterWorktree', { name: 'resume-iso' })
      return textTurn('entered')
    })
    const id = await createSession(first.sm, repo)
    const box = collectFrames(first.sm, id)
    await sendAndSettle(first.sm, id, 'enter a worktree', box)
    expect(toolResultText(box.frames, 'tu-enter')).toContain('Created worktree at')
    box.unsubscribe()
    // The index write is debounced; a restart must see this session.
    await first.store.flush()

    // Restart: a fresh provider/manager over the same state dir.
    const resumed = await makeFixture(stateDir)
    resumed.setStream((_req, round) => {
      if (round === 1) return toolUseTurn('tu-pwd', 'Bash', { command: 'pwd' })
      return textTurn('resumed')
    })
    const info = await resumed.sm.resume(id, { permissionMode: 'bypassPermissions' })
    sessionIds.push({ sm: resumed.sm, id: info.id })
    const resumedBox = collectFrames(resumed.sm, id)

    await sendAndSettle(resumed.sm, id, 'where are we?', resumedBox)
    if (process.env.WT_DEBUG) console.log('RESUMED-MSGS', JSON.stringify(resumed.requests[0]?.messages ?? []))

    expect(toolResultText(resumedBox.frames, 'tu-pwd')).toContain(worktreeOf(repo, 'resume-iso'))
    resumedBox.unsubscribe()
  })

  it('ExitWorktree keep returns the session to the launch checkout', async () => {
    const repo = await makeRepo()
    const stateDir = await mkdtemp(join(tmpdir(), 'native-worktree-exit-state-'))
    dirs.push(stateDir)
    const fx = await makeFixture(stateDir)
    fx.setStream((_req, round) => {
      if (round === 1) return toolUseTurn('tu-enter', 'EnterWorktree', { name: 'keep-me' })
      if (round === 2) return toolUseTurn('tu-exit', 'ExitWorktree', { action: 'keep' })
      if (round === 3) return toolUseTurn('tu-pwd', 'Bash', { command: 'pwd' })
      return textTurn('done')
    })
    const id = await createSession(fx.sm, repo)
    const box = collectFrames(fx.sm, id)

    await sendAndSettle(fx.sm, id, 'enter then leave', box)

    expect(toolResultText(box.frames, 'tu-exit')).toContain(`Left the worktree at “${worktreeOf(repo, 'keep-me')}”`)
    expect(toolResultText(box.frames, 'tu-pwd')).toContain(`${repo}\n`)
    // "keep" left the directory on disk.
    await expect(runGit(repo, ['worktree', 'list', '--porcelain'])).resolves.toMatchObject({
      stdout: expect.stringContaining(worktreeOf(repo, 'keep-me')),
    })
    box.unsubscribe()
  })
})
