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
] as const

function normalize(body: string) {
  return body.replace(/\s+/g, ' ').trim()
}

function rulesFor(file: string) {
  const css = readFileSync(join(process.cwd(), 'src', 'styles', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
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
