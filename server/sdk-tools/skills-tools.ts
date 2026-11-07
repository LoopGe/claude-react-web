// First-party `skills-tools` in-process MCP server (SDK createSdkMcpServer).
//
// Exposes skill management (list / get / validate / create / update / delete)
// to the agent as `mcp__skills-tools__*`, reusing server/skills.ts wholesale so
// the on-disk layout, name/frontmatter validation and path-escape guards are
// exactly the ones the skills HTTP routes use. There is no new file handling
// here — only the scope→cwd decision and the post-write reload.
//
// SCOPE is the one new decision this module makes: a project-scope call needs
// the session cwd, so without one it errors instead of quietly writing into the
// user directory or process.cwd(). A scope-less `list` in such a session
// reports user skills only.
//
// After every write the host re-discovers skills (`reloadSkillsForCwd`) so the
// live Query picks up the change; the result carries that outcome so the model
// can report a partial failure. Reads are in `readOnlyToolNames` — the
// permission-broker's exemption — while writes prompt like any other MCP tool.

import { z } from 'zod'
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { FirstPartyToolServer } from './types.js'
import { guard, json } from './call-result.js'
import {
  createSkill,
  deleteSkill,
  getSkill,
  listSkills,
  updateSkill,
  validateSkillContent,
} from '../skills.js'
import type { SkillScope } from '../../shared/skills.js'

/** Server name — tool FQN is `mcp__skills-tools__{name}`. */
export const SKILLS_TOOLS_SERVER_NAME = 'skills-tools'

/** Bare read-only tool names — permission-broker exemption via the registry. */
export const SKILLS_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['list', 'get', 'validate'])

/** Bare mutating tool names — they add / rewrite / remove SKILL.md files. */
export const SKILLS_MUTATING_TOOLS: ReadonlySet<string> = new Set(['create', 'update', 'delete'])

/** Structural slice of the host the skills tools need — declared locally so
 *  this module stays free of session internals and tests can pass a fake. */
export interface SkillsToolsHost {
  reloadSkillsForCwd(cwd?: string): Promise<unknown>
}

const PROJECT_CWD_ERROR = 'project-scope skills require a session cwd'

const SCOPE = z
  .enum(['user', 'project'])
  .describe("'project' is <cwd>/.claude/skills (this session's project); 'user' is the CLI config dir's skills/")

/** The tool definitions for the skills-tools server, bound to the host and the
 *  calling session's cwd (null when the session has none — project scope then
 *  errors). Exported separately from the server builder so tests can assert the
 *  tool set / annotations and invoke handlers without owning an McpServer. */
export function buildSkillsTools(host: SkillsToolsHost, cwd: string | null): SdkMcpToolDefinition<any>[] {
  const readOnly = { readOnlyHint: true }

  /** Project scope's directory. Errors loudly rather than falling back to the
   *  user directory or process.cwd(): writing a "project" skill into the wrong
   *  tree is worse than refusing. */
  const requireProjectCwd = (): string => {
    if (!cwd) throw new Error(PROJECT_CWD_ERROR)
    return cwd
  }

  /** cwd argument for the skills core: project scope is rooted at (and
   *  requires) the session cwd; user scope ignores it as a root but uses it to
   *  render the same project-relative `relativePath` the HTTP routes report. */
  const scopeCwd = (scope: SkillScope): string | undefined =>
    scope === 'project' ? requireProjectCwd() : cwd ?? undefined

  /** Keep a listed root/skill only when it belongs to the requested scope, or —
   *  with no scope — when it is not a project entry of a cwd-less session. */
  const inRequestedScope = <T extends { scope: SkillScope }>(entry: T, scope?: SkillScope): boolean =>
    scope ? entry.scope === scope : cwd !== null || entry.scope === 'user'

  return [
    tool(
      'list',
      "List available skills with their scope, path, validity and errors. Filter with scope; a session without a cwd returns only user-scope skills (project scope is unavailable there).",
      { scope: SCOPE.optional() },
      async (a) =>
        guard(async () => {
          const scope = a.scope
          if (scope === 'project') requireProjectCwd()
          // listSkills always reads both roots; the out-of-scope half (a
          // cwd-less session's project tree) is dropped, never returned.
          const listed = await listSkills(cwd ?? undefined)
          return json({
            roots: listed.roots.filter((root) => inRequestedScope(root, scope)),
            skills: listed.skills.filter((skill) => inRequestedScope(skill, scope)),
          })
        }),
      { annotations: readOnly },
    ),
    tool(
      'get',
      'Read one skill including its full SKILL.md content. scope must be "user" or "project".',
      { scope: SCOPE, name: z.string().describe('skill directory name') },
      async (a) =>
        guard(async () => json({ skill: await getSkill(a.scope, a.name, scopeCwd(a.scope)) })),
      { annotations: readOnly },
    ),
    tool(
      'validate',
      'Validate SKILL.md content without touching disk: checks the YAML frontmatter (required description, valid name) and, when name is given, that frontmatter.name matches it. Returns { ok, errors, name, description }.',
      { content: z.string().describe('full SKILL.md content'), name: z.string().optional().describe('expected skill name') },
      async (a) => guard(async () => json(validateSkillContent(a.content, a.name))),
      { annotations: readOnly },
    ),
    tool(
      'create',
      'Create a skill. Pass content for a full SKILL.md, or omit it to generate a stub from name/description. Fails if the skill already exists.',
      {
        scope: SCOPE,
        name: z.string().describe('skill directory name'),
        description: z.string().optional(),
        content: z.string().optional().describe('full SKILL.md; generated from name/description when omitted'),
      },
      async (a) =>
        guard(async () => {
          const skill = await createSkill({
            scope: a.scope,
            cwd: scopeCwd(a.scope),
            name: a.name,
            description: a.description,
            content: a.content,
          })
          const reload = await host.reloadSkillsForCwd(a.scope === 'project' ? cwd ?? undefined : undefined)
          return json({ skill, reload })
        }),
    ),
    tool(
      'update',
      'Replace an existing skill\'s SKILL.md content. The content is validated first and frontmatter.name must match the directory name.',
      { scope: SCOPE, name: z.string().describe('skill directory name'), content: z.string().describe('full SKILL.md') },
      async (a) =>
        guard(async () => {
          const skill = await updateSkill({ scope: a.scope, cwd: scopeCwd(a.scope), name: a.name, content: a.content })
          const reload = await host.reloadSkillsForCwd(a.scope === 'project' ? cwd ?? undefined : undefined)
          return json({ skill, reload })
        }),
    ),
    tool(
      'delete',
      'Delete a skill directory (recursive, no confirmation). Returns { ok, reload }.',
      { scope: SCOPE, name: z.string().describe('skill directory name') },
      async (a) =>
        guard(async () => {
          await deleteSkill(a.scope, a.name, scopeCwd(a.scope))
          const reload = await host.reloadSkillsForCwd(a.scope === 'project' ? cwd ?? undefined : undefined)
          return json({ ok: true, reload })
        }),
    ),
  ]
}

/** Build the skills-tools first-party server bound to a host. requiresCwd is
 *  false — user-scope management works without a session cwd; only project
 *  scope needs one, and it errors loudly when absent. */
export function createSkillsTools(host: SkillsToolsHost): FirstPartyToolServer {
  return {
    name: SKILLS_TOOLS_SERVER_NAME,
    description: 'List, read, validate, create, update and delete skills (user and project scope)',
    defaultEnabled: true,
    requiresCwd: false,
    buildTools: (cwd) => buildSkillsTools(host, cwd),
    readOnlyToolNames: SKILLS_READ_ONLY_TOOLS,
    mutatingToolNames: SKILLS_MUTATING_TOOLS,
  }
}
