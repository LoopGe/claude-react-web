// server/providers/native/prompt/overlay.test.ts
import { describe, expect, it } from 'vitest'
import { joinPromptParts, renderMemorySection, renderEnvironment } from './overlay.js'
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
