// server/providers/native/prompt/sections.test.ts
import { describe, expect, it } from 'vitest'
import { IDENTITY_SECTION, PromptSectionRegistry } from './sections.js'
import { TASK_OUTPUT_GUIDANCE } from '../tools/task-output.js'

describe('PromptSectionRegistry', () => {
  it('renders sections ordered by order', () => {
    const reg = new PromptSectionRegistry()
    reg.register({ name: 'b', order: 20, text: 'B' })
    reg.register(IDENTITY_SECTION)
    reg.register({ name: 'a', order: 10, text: 'A' })
    expect(reg.render()).toBe('You are an AI agent powered by claude-react-web.\n\nA\n\nB')
  })

  it('renders TaskOutput guidance between Agent and Skill', () => {
    const reg = new PromptSectionRegistry()
    reg.register({ name: 'tool:Skill', order: 85, text: 'Skill guidance' })
    reg.register({ name: 'tool:TaskOutput', order: 82, text: TASK_OUTPUT_GUIDANCE })
    reg.register({ name: 'tool:Agent', order: 80, text: 'Agent guidance' })

    expect(reg.render()).toBe(`Agent guidance\n\n${TASK_OUTPUT_GUIDANCE}\n\nSkill guidance`)
  })

  it('throws on duplicate names', () => {
    const reg = new PromptSectionRegistry()
    reg.register({ name: 'x', order: 1, text: 'x' })
    expect(() => reg.register({ name: 'x', order: 2, text: 'y' })).toThrow('duplicate prompt section: x')
  })

  it('breaks order ties by name', () => {
    const reg = new PromptSectionRegistry()
    reg.register({ name: 'z', order: 5, text: 'Z' })
    reg.register({ name: 'a', order: 5, text: 'A' })
    expect(reg.render()).toBe('A\n\nZ')
  })

  it('has() reports membership', () => {
    const reg = new PromptSectionRegistry()
    reg.register(IDENTITY_SECTION)
    expect(reg.has('harness:identity')).toBe(true)
    expect(reg.has('nope')).toBe(false)
  })
})
