import { resolve } from 'node:path'
import { parseSkillFrontmatter } from '../../skills.js'

/** Render the stable instruction body shared by `/name` and the Skill tool. */
export function renderNativeSkillBody(input: { directory: string; document: string }): string {
  const parsed = parseSkillFrontmatter(input.document)
  if (parsed.body === undefined || parsed.errors.length > 0) {
    throw new Error(`Invalid SKILL.md: ${parsed.errors.join('; ')}`)
  }
  // A single empty line between frontmatter and body is the document's
  // separator; the canonical prefix owns that separator in the rendered form.
  const body = parsed.body.replace(/^\r?\n/, '')
  return `Base directory for this skill: ${resolve(input.directory)}\n\n${body}`
}

/** Only the model tool protocol carries arguments; slash expansion does not. */
export function renderNativeSkillToolResult(body: string, args: string): string {
  return args.trim() ? `${body}\n\n## User Request\n${args}` : body
}
