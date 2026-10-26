import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkills } from './skills-remote.js'

async function makeTree(): Promise<{ base: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), 'skills-remote-'))
  return { base, cleanup: () => rm(base, { recursive: true, force: true }) }
}

/** relDir uses forward slashes; '' writes the skill at the tree root. */
async function writeSkill(base: string, relDir: string, content: string | Buffer): Promise<void> {
  const dir = relDir ? join(base, ...relDir.split('/')) : base
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), content)
}

function skillDoc(fields: { name?: string; description?: string }): string {
  const lines = ['---']
  if (fields.name !== undefined) lines.push(`name: ${fields.name}`)
  if (fields.description !== undefined) lines.push(`description: ${fields.description}`)
  lines.push('---', '', '# body', '')
  return lines.join('\n')
}

describe('discoverSkills', () => {
  it('finds nested skills and reads description from frontmatter', async () => {
    const { base, cleanup } = await makeTree()
    try {
      await writeSkill(base, 'skills/pdf', skillDoc({ name: 'pdf', description: 'Read PDFs' }))
      await writeSkill(base, 'skills/docx', skillDoc({ description: 'Read DOCX' }))
      const found = await discoverSkills(base)
      expect(found).toEqual(
        expect.arrayContaining([
          { name: 'pdf', description: 'Read PDFs', relativePath: 'skills/pdf' },
          { name: 'docx', description: 'Read DOCX', relativePath: 'skills/docx' },
        ]),
      )
    } finally {
      await cleanup()
    }
  })

  it('reports a root-level skill with relativePath ""', async () => {
    const { base, cleanup } = await makeTree()
    try {
      await writeSkill(base, '', skillDoc({ name: 'root-skill' }))
      const found = await discoverSkills(base)
      expect(found).toEqual([{ name: 'root-skill', description: '', relativePath: '' }])
    } finally {
      await cleanup()
    }
  })

  it('skips SKIP_DIRS and stops at depth 5', async () => {
    const { base, cleanup } = await makeTree()
    try {
      await writeSkill(base, 'node_modules/x', skillDoc({ name: 'x', description: 'nope' }))
      await writeSkill(base, 'a/b/c/d/e/f', skillDoc({ name: 'too-deep', description: 'nope' }))
      await writeSkill(base, 'a/b/c/d/e', skillDoc({ name: 'e', description: 'ok' }))
      const found = await discoverSkills(base)
      expect(found.map((s) => s.relativePath)).toEqual(['a/b/c/d/e'])
    } finally {
      await cleanup()
    }
  })

  it('ignores a skill deeper than the depth limit even when no ancestor is a skill dir', async () => {
    // Isolates the depth rule from "don't descend into a SKILL.md dir":
    // base/a/b/c/d/e/f is 6 levels below the base (depth 6), so it is never
    // visited, while base/a/b/c/d/e (depth 5) is the boundary and is found.
    const { base, cleanup } = await makeTree()
    try {
      await mkdir(join(base, 'a', 'b', 'c', 'd', 'e'), { recursive: true })
      await writeSkill(base, 'a/b/c/d/e/f', skillDoc({ name: 'too-deep', description: 'nope' }))
      expect(await discoverSkills(base)).toEqual([])
      await writeSkill(base, 'a/b/c/d/e', skillDoc({ name: 'boundary', description: 'ok' }))
      const found = await discoverSkills(base)
      expect(found.map((s) => s.relativePath)).toEqual(['a/b/c/d/e'])
    } finally {
      await cleanup()
    }
  })

  it('does not descend into a directory that contains SKILL.md', async () => {
    const { base, cleanup } = await makeTree()
    try {
      await writeSkill(base, 'parent', skillDoc({ name: 'parent', description: 'outer' }))
      await writeSkill(base, 'parent/child', skillDoc({ name: 'child', description: 'inner' }))
      const found = await discoverSkills(base)
      expect(found.map((s) => s.relativePath)).toEqual(['parent'])
    } finally {
      await cleanup()
    }
  })

  it('falls back to the directory basename when frontmatter has no name', async () => {
    const { base, cleanup } = await makeTree()
    try {
      await writeSkill(base, 'skills/my-tool', skillDoc({ description: 'Does a thing' }))
      const found = await discoverSkills(base)
      expect(found[0]!.name).toBe('my-tool')
    } finally {
      await cleanup()
    }
  })

  it('skips a SKILL.md larger than MAX_SKILL_BYTES', async () => {
    const { base, cleanup } = await makeTree()
    try {
      // 1 MiB + 1 bytes exceeds MAX_SKILL_BYTES (1024 * 1024)
      await writeSkill(base, 'big', Buffer.alloc(1024 * 1024 + 1, 0x61))
      expect(await discoverSkills(base)).toEqual([])
    } finally {
      await cleanup()
    }
  })
})
