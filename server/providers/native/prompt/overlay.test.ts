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
  it('exact format with day-granularity date', () => {
    expect(renderEnvironment({
      cwd: '/repo',
      isGitRepo: true,
      platform: 'win32',
      date: new Date('2026-11-27T15:00:00Z'),
    })).toBe(
      "# Environment\nWorking directory: /repo\nIs a git repository: true\nPlatform: win32\nToday's date: 2026-11-27",
    )
  })

  it('renders a non-repo cwd', () => {
    expect(renderEnvironment({
      cwd: '/tmp/scratch',
      isGitRepo: false,
      platform: 'linux',
      date: new Date('2026-01-02T23:59:59Z'),
    })).toBe(
      "# Environment\nWorking directory: /tmp/scratch\nIs a git repository: false\nPlatform: linux\nToday's date: 2026-01-02",
    )
  })
})
