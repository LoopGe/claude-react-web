import { describe, it, expect } from 'vitest'
import { planSubmission } from './submission'

describe('planSubmission', () => {
  const identity = (text: string) => text

  it('routes a plain message to the model', () => {
    expect(planSubmission('hello', identity)).toEqual({ mode: 'prompt', text: 'hello' })
  })

  it('routes a bare ! command to the local shell, unshared', () => {
    expect(planSubmission('!ls -la', identity)).toEqual({
      mode: 'bash',
      share: false,
      command: 'ls -la',
    })
  })

  it('routes a !! command to the shared shell', () => {
    expect(planSubmission('!!ls -la', identity)).toEqual({
      mode: 'bash',
      share: true,
      command: 'ls -la',
    })
  })

  it('treats a lone ! or !! as an ordinary message', () => {
    // Too short to carry a command; the pre-existing guards.
    expect(planSubmission('!', identity)).toEqual({ mode: 'prompt', text: '!' })
    expect(planSubmission('!!', identity)).toEqual({ mode: 'prompt', text: '!!' })
  })

  it('expands the command payload so ! followed by a paste still runs', () => {
    const expand = (t: string) => t.replace('[Pasted text #1]', 'echo hi')
    expect(planSubmission('! [Pasted text #1]', expand)).toEqual({
      mode: 'bash',
      share: false,
      command: ' echo hi',
    })
  })

  // The regression this file exists for. A collapsed paste keeps its body out
  // of the composer, so the user never typed a `!` — routing on the EXPANDED
  // text would run their pasted file as an unsandboxed shell command.
  it('sends a collapsed paste to the model even when its body starts with !', () => {
    const expand = () => '!deploy.sh --force'
    expect(planSubmission('[Pasted text #1 +240 lines]', expand)).toEqual({
      mode: 'prompt',
      text: '!deploy.sh --force',
    })
  })

  it('sends a collapsed paste to the model even when its body starts with /clear', () => {
    const expand = () => '/clear'
    expect(planSubmission('[Pasted text #1 +240 lines]', expand)).toEqual({
      mode: 'prompt',
      text: '/clear',
    })
  })
})
