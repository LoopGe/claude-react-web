// @vitest-environment node
// The A-group and B-group keyframes are exact duplicates. Keep one canonical
// definition per group, make every CSS consumer point at it, and keep the
// useRevealClass animationName arguments in sync. The C group stays untouched.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const styleDir = join(process.cwd(), 'src', 'styles')
const files = ['styles.css', ...readdirSync(styleDir).filter((file) => file.endsWith('.css'))]
const cssByFile = new Map(
  files.map((file) => {
    const path = file === 'styles.css' ? join(process.cwd(), 'src', file) : join(styleDir, file)
    return [file, readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')] as const
  }),
)

const GROUPS = [
  {
    canonical: 'spin',
    retired: ['handoff-spin'],
    references: { 'chat.css': 2 },
  },
  {
    canonical: 'content-enter',
    retired: ['chat-empty-item-in', 'app-loading-card-in'],
    references: { 'chat.css': 1, 'layout.css': 1 },
  },
  {
    canonical: 'opacity-pulse-30',
    retired: ['chat-empty-env-dot-pulse', 'subagent-child-pulse'],
    references: { 'chat.css': 2 },
  },
  {
    canonical: 'status-pulse',
    retired: ['msg-queued-pulse', 'msg-processing-pulse', 'session-nav-pulse', 'titlebar-tab-pulse'],
    references: { 'chat.css': 2, 'layout.css': 1, 'titlebar.css': 1 },
  },
  {
    canonical: 'opacity-pulse-40',
    retired: ['workflow-pulse', 'session-await-pulse'],
    references: { 'chat.css': 1, 'session-list.css': 2 },
  },
  {
    canonical: 'accent-wash-pulse',
    retired: ['session-nav-working-pulse', 'titlebar-tab-working-pulse'],
    references: { 'layout.css': 1, 'titlebar.css': 1 },
  },
  {
    canonical: 'overlay-backdrop-out',
    retired: ['panel-exit'],
    references: { 'layout.css': 2 },
  },
  {
    canonical: 'empty-state-enter',
    retired: ['app-empty-state-in', 'setup-card-in'],
    references: { 'layout.css': 1, 'setup-page.css': 1 },
  },
  {
    canonical: 'item-enter',
    retired: ['phase-label-in', 'git-file-row-in', 'marketplace-card-in', 'session-item-enter', 'setup-status-in', 'tool-result-enter', 'tool-group-member-enter'],
    references: { 'chat.css': 2, 'git-panel.css': 1, 'marketplace.css': 1, 'session-list.css': 1, 'setup-page.css': 1, 'utilities.css': 2 },
  },
  {
    canonical: 'fade-in',
    retired: ['overlay-backdrop-in', 'recap-body-in', 'grid-clip-reveal'],
    references: {
      'chat.css': 3,
      'git-panel.css': 1,
      'layout.css': 1,
      'messages.css': 1,
      'overlays.css': 3,
      'session-list.css': 1,
      'tasks-panel.css': 1,
      'utilities.css': 1,
    },
  },
] as const

const REVEAL_CONSUMERS = [
  { file: 'src/components/ToolCard.tsx', canonical: 'item-enter', retired: 'tool-result-enter' },
  { file: 'src/components/message-list/ToolGroupCard.tsx', canonical: 'item-enter', retired: 'tool-group-member-enter' },
  { file: 'src/components/GridClipEnter.tsx', canonical: 'fade-in', retired: 'grid-clip-reveal' },
] as const

describe.each(REVEAL_CONSUMERS)('$file animationName sync', ({ file, canonical, retired }) => {
  it(`uses ${canonical} instead of ${retired}`, () => {
    const source = readFileSync(join(process.cwd(), file), 'utf8')
    expect(source).toContain(`useRevealClass(entering, '${canonical}')`)
    expect(source).not.toContain(`useRevealClass(entering, '${retired}')`)
  })
})

function namePattern(name: string) {
  return new RegExp(`(^|[^a-zA-Z0-9_-])${name}(?=$|[^a-zA-Z0-9_-])`, 'g')
}

function animationReferenceCount(css: string, name: string) {
  let count = 0
  for (const match of css.matchAll(/\banimation(?:-name)?\s*:\s*([^;}]+)/g)) {
    count += [...match[1].matchAll(namePattern(name))].length
  }
  return count
}

describe.each(GROUPS)('$canonical keyframe dedup', ({ canonical, retired, references }) => {
  it('has one canonical definition and the expected consumer references', () => {
    const allCss = [...cssByFile.values()].join('\n')
    const definitions = [...allCss.matchAll(new RegExp(`@keyframes\\s+${canonical}\\b`, 'g'))]
    expect(definitions).toHaveLength(1)

    for (const [file, expected] of Object.entries(references)) {
      expect(animationReferenceCount(cssByFile.get(file)!, canonical), file).toBe(expected)
    }
  })

  it('has no retired keyframe definitions or animation references', () => {
    const allCss = [...cssByFile.values()].join('\n')
    for (const name of retired) {
      expect(allCss).not.toMatch(new RegExp(`@keyframes\\s+${name}\\b`))
      expect(animationReferenceCount(allCss, name), name).toBe(0)
    }
  })
})
