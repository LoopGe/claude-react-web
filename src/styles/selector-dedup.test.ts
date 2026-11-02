// @vitest-environment node
// Exact selector-list dedup: every target keeps its existing class and the
// hand-checked declaration body, but appears in only one rule with that body.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const GROUPS = [
  {
    name: 'accent scrollbar normal',
    file: 'overlay-scrollbar.css',
    selectors: ['.chat-panel .os-thumb', '.sidebar .os-thumb', '[data-portaled] .os-thumb'],
    body: 'background: color-mix(in srgb, var(--accent) 35%, transparent);',
  },
  {
    name: 'accent scrollbar hover',
    file: 'overlay-scrollbar.css',
    selectors: ['.chat-panel .os-thumb:hover', '.sidebar .os-thumb:hover', '[data-portaled] .os-thumb:hover'],
    body: 'background: color-mix(in srgb, var(--accent) 70%, transparent);',
  },
  {
    name: 'accent scrollbar active',
    file: 'overlay-scrollbar.css',
    selectors: ['.chat-panel .os-thumb:active', '.sidebar .os-thumb:active', '[data-portaled] .os-thumb:active'],
    body: 'background: var(--accent);',
  },
  {
    name: 'mobile settings scrollbar',
    file: 'utilities.css',
    selectors: ['.global-settings-tabs', '.settings-tab-leaves'],
    body: 'overflow-x: auto; flex-wrap: nowrap; scrollbar-width: none;',
  },
  {
    name: 'mobile settings WebKit scrollbar',
    file: 'utilities.css',
    selectors: ['.global-settings-tabs::-webkit-scrollbar', '.settings-tab-leaves::-webkit-scrollbar'],
    body: 'display: none;',
  },
  {
    name: 'dock collapse base',
    file: 'messages.css',
    selectors: ['.todo-panel-collapse', '.monitor-bar-collapse'],
    body: `
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: var(--size-20px);
      height: var(--size-20px);
      padding: 0;
      border: none;
      background: transparent;
      color: var(--fg-muted);
      cursor: pointer;
      border-radius: var(--radius-sm);
      transition: background var(--motion-duration-fast) var(--motion-ease-standard),
                  color var(--motion-duration-fast) var(--motion-ease-standard);
    `,
  },
  {
    name: 'dock collapse hover',
    file: 'messages.css',
    selectors: ['.todo-panel-collapse:hover', '.monitor-bar-collapse:hover'],
    body: 'background: var(--btn-hover-bg); color: var(--fg);',
  },
  {
    name: 'dock collapse open icon',
    file: 'messages.css',
    selectors: ['.todo-panel-collapse.open svg', '.monitor-bar-collapse.open svg'],
    body: 'transform: rotate(180deg);',
  },
  {
    name: 'dock collapse icon transition',
    file: 'messages.css',
    selectors: ['.todo-panel-collapse svg', '.monitor-bar-collapse svg'],
    body: 'transition: transform var(--motion-duration-fast) var(--motion-ease-standard);',
  },
  {
    name: 'dock collapse focus',
    file: 'messages.css',
    selectors: ['.todo-panel-collapse:focus-visible', '.monitor-bar-collapse:focus-visible'],
    body: 'outline: var(--focus-ring); outline-offset: 1px;',
  },
  {
    name: 'drawer root',
    file: 'chat.css',
    selectors: ['.subagent-overlay', '.workflow-overlay'],
    body: 'position: absolute; inset: 0; z-index: var(--z-panel-overlay); display: flex; justify-content: flex-end;',
  },
  {
    name: 'drawer scrim',
    file: 'chat.css',
    selectors: ['.subagent-overlay-scrim', '.workflow-overlay-scrim'],
    body: 'position: absolute; inset: 0; z-index: 0; background: color-mix(in srgb, var(--bg) 62%, transparent); animation: fade-in var(--motion-duration-base) var(--motion-ease-standard) backwards;',
  },
  {
    name: 'drawer closing scrim',
    file: 'chat.css',
    selectors: [".subagent-overlay[data-state='closing'] .subagent-overlay-scrim", ".workflow-overlay[data-state='closing'] .workflow-overlay-scrim"],
    body: 'animation: overlay-backdrop-out var(--motion-duration-base) var(--motion-ease-exit) forwards;',
  },
  {
    name: 'drawer panel shared',
    file: 'chat.css',
    selectors: ['.subagent-overlay-panel', '.workflow-overlay-panel'],
    body: 'height: 100%; position: relative; z-index: 1; background: var(--bg); border-left: 1px solid var(--border); display: flex; flex-direction: column; box-shadow: var(--drawer-shadow); animation: drawer-in var(--motion-duration-base) var(--motion-ease-enter) backwards;',
  },
  {
    name: 'subagent panel width',
    file: 'chat.css',
    selectors: ['.subagent-overlay-panel'],
    body: 'width: min(50%, 640px); min-width: 320px;',
  },
  {
    name: 'workflow panel width',
    file: 'chat.css',
    selectors: ['.workflow-overlay-panel'],
    body: 'width: min(75%, 900px); min-width: 480px;',
  },
  {
    name: 'drawer closing panel',
    file: 'chat.css',
    selectors: [".subagent-overlay[data-state='closing'] .subagent-overlay-panel", ".workflow-overlay[data-state='closing'] .workflow-overlay-panel"],
    body: 'animation: drawer-out var(--motion-duration-base) var(--motion-ease-exit) forwards;',
  },
  {
    name: 'drawer header',
    file: 'chat.css',
    selectors: ['.subagent-overlay-header', '.workflow-overlay-header'],
    body: 'display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2-5) var(--space-3); border-bottom: 1px solid var(--border); flex-shrink: 0;',
  },
  {
    name: 'drawer action buttons',
    file: 'chat.css',
    selectors: ['.subagent-overlay-back', '.subagent-overlay-close', '.workflow-overlay-close'],
    body: 'background: transparent; border: 1px solid transparent; color: var(--fg-muted); cursor: pointer; font-size: var(--fs-md); padding: var(--space-0-5) var(--space-2); border-radius: var(--radius-xs); flex-shrink: 0;',
  },
  {
    name: 'drawer action hover',
    file: 'chat.css',
    selectors: ['.subagent-overlay-back:hover', '.subagent-overlay-close:hover', '.workflow-overlay-close:hover'],
    body: 'border-color: var(--border); color: var(--fg); background: var(--bg-elev);',
  },
  {
    name: 'drawer title',
    file: 'chat.css',
    selectors: ['.subagent-overlay-title', '.workflow-overlay-title'],
    body: 'flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--space-0-5);',
  },
  {
    name: 'drawer current label',
    file: 'chat.css',
    selectors: ['.subagent-overlay-current-label', '.workflow-overlay-current-label'],
    body: 'font-size: var(--fs-base); font-weight: 600; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
  },
  {
    name: 'drawer status',
    file: 'chat.css',
    selectors: ['.subagent-overlay-status', '.workflow-overlay-status'],
    body: 'font-size: var(--fs-sm); font-family: var(--mono); color: var(--fg-muted);',
  },
  {
    name: 'drawer running status',
    file: 'chat.css',
    selectors: ['.subagent-overlay-status.status-running', '.subagent-overlay-status.status-background', '.workflow-overlay-status.status-running'],
    body: 'color: var(--accent-text);',
  },
  {
    name: 'drawer done status',
    file: 'chat.css',
    selectors: ['.subagent-overlay-status.status-done', '.workflow-overlay-status.status-done'],
    body: 'color: var(--ok-text);',
  },
  {
    name: 'drawer warning status',
    file: 'chat.css',
    selectors: ['.subagent-overlay-status.status-rejected', '.subagent-overlay-status.status-interrupted', '.workflow-overlay-status.status-rejected', '.workflow-overlay-status.status-interrupted'],
    body: 'color: var(--warn-text);',
  },
  {
    name: 'drawer body shared',
    file: 'chat.css',
    selectors: ['.subagent-overlay-body', '.workflow-overlay-body'],
    body: 'flex: 1; min-height: 0; display: flex; overflow: hidden;',
  },
  {
    name: 'subagent body direction',
    file: 'chat.css',
    selectors: ['.subagent-overlay-body'],
    body: 'flex-direction: column;',
  },
  {
    name: 'workflow body direction',
    file: 'chat.css',
    selectors: ['.workflow-overlay-body'],
    body: 'flex-direction: row;',
  },
  {
    name: 'mobile drawer panel',
    file: 'utilities.css',
    selectors: ['.subagent-overlay-panel', '.workflow-overlay-panel'],
    body: 'width: 100%; min-width: 0; border-left: none; animation-name: subagent-sheet-in;',
  },
  {
    name: 'mobile drawer closing panel',
    file: 'utilities.css',
    selectors: ['.subagent-overlay[data-state="closing"] .subagent-overlay-panel', '.workflow-overlay[data-state="closing"] .workflow-overlay-panel'],
    body: 'animation-name: subagent-sheet-out;',
  },
] as const

function normalize(body: string) {
  return body.replace(/\s+/g, ' ').trim()
}

function rulesFor(file: string, mediaQuery?: string) {
  let css = readFileSync(join(process.cwd(), 'src', 'styles', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  if (mediaQuery) {
    const marker = `@media ${mediaQuery}`
    const start = css.indexOf(marker)
    expect(start, `${file} contains ${marker}`).toBeGreaterThanOrEqual(0)
    const open = css.indexOf('{', start)
    let depth = 1
    let index = open + 1
    while (depth > 0 && index < css.length) {
      if (css[index] === '{') depth++
      else if (css[index] === '}') depth--
      index++
    }
    if (depth !== 0) throw new Error(`Unclosed ${marker} in ${file}`)
    css = css.slice(open + 1, index - 1)
  }
  return [...css.matchAll(/(^|\n)([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[2].split(',').map((selector) => selector.trim()),
    body: normalize(match[3]),
  }))
}

describe.each(GROUPS)('$name selector dedup', ({ file, selectors, body }) => {
  it('shares one exact rule and has no duplicate rule with the same body', () => {
    const rules = rulesFor(file)
    const expected = normalize(body)
    const shared = rules.filter((rule) =>
      selectors.every((selector) => rule.selectors.includes(selector)) && rule.body === expected,
    )
    expect(shared).toHaveLength(1)

    for (const selector of selectors) {
      const duplicates = rules.filter((rule) => rule.selectors.includes(selector) && rule.body === expected)
      expect(duplicates, selector).toHaveLength(1)
    }
  })
})

const MOBILE_GROUPS = GROUPS.filter((group) => group.name.startsWith('mobile '))
describe.each(MOBILE_GROUPS)('$name media scope', ({ file, selectors, body }) => {
  it('stays inside max-width: 768px', () => {
    const rules = rulesFor(file, '(max-width: 768px)')
    const expected = normalize(body)
    const shared = rules.filter((rule) =>
      selectors.every((selector) => rule.selectors.includes(selector)) && rule.body === expected,
    )
    expect(shared).toHaveLength(1)
  })
})
