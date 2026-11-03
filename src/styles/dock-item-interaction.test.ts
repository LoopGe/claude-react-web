// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(process.cwd(), 'src', 'styles', 'messages.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function ruleBodies(selector: string) {
  const pattern = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`, 'g')
  const bodies = [...css.matchAll(pattern)].map((match) => match[1])
  if (bodies.length === 0) throw new Error(`Missing standalone rule: ${selector}`)
  return bodies
}

describe('dock item hover parity', () => {
  it('monitor items keep the todo item corner radius and background transition', () => {
    const todo = ruleBodies('.todo-item')
    const monitor = ruleBodies('.monitor-item')

    for (const body of todo) {
      expect(body).toContain('border-radius: var(--radius-xs)')
      expect(body).toContain('transition: background var(--motion-duration-instant) linear')
    }
    for (const body of monitor) {
      expect(body).toContain('border-radius: var(--radius-xs)')
      expect(body).toContain('transition: background var(--motion-duration-instant) linear')
    }
  })
})
