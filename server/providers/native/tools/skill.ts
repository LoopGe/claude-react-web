// server/providers/native/tools/skill.ts
import type { NativeSkillCatalog } from '../skills.js'
import type { ToolDef } from './types.js'

/** The Skill tool's prompt-section guidance. Exported so the provider's static
 *  `tool:Skill` prompt section and the tool definition cannot drift. */
export const SKILL_GUIDANCE =
  'Load a skill by name with the Skill tool before a task the skill covers; the result is the skill instruction body.'

export function createSkillTool(catalog: NativeSkillCatalog): ToolDef<{ skill: string; args?: string }> {
  return {
    name: 'Skill',
    description:
      'Load the full instructions of a local skill by name and follow them for the current task.',
    guidance: SKILL_GUIDANCE,
    promptOrder: 85,
    readOnlyHint: true,
    schema: {
      type: 'object',
      properties: {
        skill: { type: 'string' },
        args: { type: 'string' },
      },
      required: ['skill'],
    },
    async run(input) {
      // `bodyOf` answers the whole selection policy: an unknown name, a
      // disabled skill and a `disable-model-invocation` skill all come back as
      // an error, so the tool never leaks a body the model may not load.
      const result = catalog.bodyOf(input.skill)
      if (result.isError) return result
      const args = typeof input.args === 'string' ? input.args : ''
      return { text: args ? `${result.text}\n\nArguments: ${args}` : result.text }
    },
  }
}
