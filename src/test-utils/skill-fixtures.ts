import type { SkillRecord } from '../../shared/skills'

/** Base SkillRecord factory for tests — pass the fields the scenario
 *  needs; the rest are neutral defaults. */
export function mkSkillRecord(over: Partial<SkillRecord> = {}): SkillRecord {
  const name = over.name ?? 'test-skill'
  return {
    scope: 'project',
    name,
    description: '',
    path: `/x/${name}/SKILL.md`,
    relativePath: `${name}/SKILL.md`,
    readOnly: false,
    valid: true,
    errors: [],
    ...over,
  }
}
