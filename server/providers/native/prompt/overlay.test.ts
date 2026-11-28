// server/providers/native/prompt/overlay.test.ts
import { describe, expect, it } from 'vitest'
import { joinPromptParts, renderMemorySection, renderAutoMemorySection, renderEnvironment } from './overlay.js'
import type { NativeMemoryFile } from '../ports.js'

describe('joinPromptParts', () => {
  it('drops empty parts', () => {
    expect(joinPromptParts('A', '', 'B')).toBe('A\n\nB')
    expect(joinPromptParts('', '', '')).toBe('')
    expect(joinPromptParts('A')).toBe('A')
    expect(joinPromptParts()).toBe('')
  })
})

describe('renderMemorySection', () => {
  it('empty → empty string', () => {
    expect(renderMemorySection([])).toBe('')
  })

  it('formats labels and preserves input order', () => {
    const files: NativeMemoryFile[] = [
      { path: '/repo/CLAUDE.md', scope: 'project', content: 'PROJECT-RULES' },
      { path: '/repo/CLAUDE.local.md', scope: 'local', content: 'LOCAL-RULES' },
    ]
    expect(renderMemorySection(files)).toBe(
      '# Memory Files\n\n'
      + 'Contents of /repo/CLAUDE.md (project instructions):\nPROJECT-RULES\n\n'
      + 'Contents of /repo/CLAUDE.local.md (local project instructions):\nLOCAL-RULES',
    )
  })

  it('labels the user scope', () => {
    const files: NativeMemoryFile[] = [
      { path: '/home/.claude/CLAUDE.md', scope: 'user', content: 'USER-RULES' },
    ]
    expect(renderMemorySection(files)).toBe(
      '# Memory Files\n\nContents of /home/.claude/CLAUDE.md (user instructions):\nUSER-RULES',
    )
  })
})

describe('renderAutoMemorySection', () => {
  // The verbatim section copy (task brief), directory + index interpolated.
  const COPY = (ownDir: string, index: string): string =>
    '# Memory\n\n'
    + `You have a persistent file-based memory at \`${ownDir}\`. This directory already exists — write to it directly with the Write tool.\n\n`
    + 'Each memory is one file with frontmatter: name (short kebab-case slug), description (one-line summary), metadata.type (user | feedback | project | reference). The body is the fact.\n\n'
    + `Maintain \`${ownDir}/MEMORY.md\` as an index: one line per memory, \`- [Title](file.md) — hook\`.\n\n`
    + `Save when you learn something worth persisting across sessions: user preferences, feedback on how to work, project constraints not derivable from code, external references. Do not save what the repo already records (code structure, git history, CLAUDE.md). Check for an existing memory before creating a duplicate; update rather than duplicate; delete memories that turn out wrong. Save in the same reply where you learn the fact. Write only inside \`${ownDir}\`.\n\n`
    + `Current index:\n${index}`

  it('renders the exact copy with the directory and index interpolated', () => {
    expect(renderAutoMemorySection({ ownDir: '/store/mem', index: '- [A](a.md) — hook' }))
      .toBe(COPY('/store/mem', '- [A](a.md) — hook'))
  })

  it('a null index renders the "(empty index)" placeholder', () => {
    expect(renderAutoMemorySection({ ownDir: '/store/mem', index: null }))
      .toBe(COPY('/store/mem', '(empty index)'))
  })

  it('an empty or whitespace-only index renders the placeholder (the port provisions an empty MEMORY.md)', () => {
    expect(renderAutoMemorySection({ ownDir: '/store/mem', index: '' }))
      .toBe(COPY('/store/mem', '(empty index)'))
    expect(renderAutoMemorySection({ ownDir: '/store/mem', index: '\n' }))
      .toBe(COPY('/store/mem', '(empty index)'))
  })

  it('names the absolute directory, the frontmatter convention and the index content', () => {
    const section = renderAutoMemorySection({ ownDir: '/abs/dir', index: 'INDEX-BODY' })
    expect(section).toContain('# Memory')
    expect(section).toContain('/abs/dir')
    expect(section).toContain('frontmatter')
    expect(section).toContain('metadata.type (user | feedback | project | reference)')
    expect(section).toContain('INDEX-BODY')
  })
})

describe('renderEnvironment', () => {
  // Local-time constructors: the expected day is the LOCAL day by
  // construction, so the assertions hold in any timezone.
  it('exact format with day-granularity date', () => {
    expect(renderEnvironment({
      cwd: '/repo',
      isGitRepo: true,
      platform: 'win32',
      date: new Date(2026, 10, 27, 15, 0, 0),
    })).toBe(
      "# Environment\nWorking directory: /repo\nIs a git repository: true\nPlatform: win32\nToday's date: 2026-11-27",
    )
  })

  it('renders a non-repo cwd', () => {
    expect(renderEnvironment({
      cwd: '/tmp/scratch',
      isGitRepo: false,
      platform: 'linux',
      date: new Date(2026, 0, 2, 23, 59, 59),
    })).toBe(
      "# Environment\nWorking directory: /tmp/scratch\nIs a git repository: false\nPlatform: linux\nToday's date: 2026-01-02",
    )
  })

  it('renders the LOCAL calendar day, not the UTC day', () => {
    // Local 00:30 east of UTC is still the PREVIOUS UTC day; local 23:30
    // west of UTC is already the NEXT UTC day. Each construct pins its
    // local day by construction, so a UTC renderer fails at least one of
    // them in every non-UTC timezone.
    const early = renderEnvironment({
      cwd: '/repo',
      isGitRepo: true,
      platform: 'win32',
      date: new Date(2026, 10, 27, 0, 30, 0),
    })
    expect(early).toContain("Today's date: 2026-11-27")
    const late = renderEnvironment({
      cwd: '/repo',
      isGitRepo: true,
      platform: 'win32',
      date: new Date(2026, 0, 2, 23, 30, 0),
    })
    expect(late).toContain("Today's date: 2026-01-02")
  })
})
