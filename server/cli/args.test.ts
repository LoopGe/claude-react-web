import { describe, expect, it } from 'vitest'
import { parseServerArgs } from './args.js'

describe('parseServerArgs --dev / --no-dev', () => {
  it('leaves dev undefined when neither flag is given (auto-detect)', () => {
    expect(parseServerArgs([]).dev).toBeUndefined()
  })

  it('sets dev true for --dev', () => {
    expect(parseServerArgs(['--dev']).dev).toBe(true)
  })

  it('sets dev false for --no-dev', () => {
    expect(parseServerArgs(['--no-dev']).dev).toBe(false)
  })

  it('lets a later flag win', () => {
    expect(parseServerArgs(['--dev', '--no-dev']).dev).toBe(false)
  })

  it('does not disturb the existing flags', () => {
    const args = parseServerArgs(['--dev', '-p', '4000', '--no-open'])
    expect(args).toMatchObject({ dev: true, port: 4000, open: false })
  })
})
