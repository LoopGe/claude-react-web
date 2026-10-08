import { describe, expect, it } from 'vitest'
import { mcpDiagnostic } from './mcp-types.js'

describe('mcpDiagnostic', () => {
  it('builds a runnable command line from a stdio config', () => {
    expect(mcpDiagnostic({ type: 'stdio', command: 'npx', args: ['-y', '@mi/adt-mcp-conn'] })).toEqual({
      kind: 'command',
      value: 'npx -y @mi/adt-mcp-conn',
    })
  })

  it('keeps an empty args list from changing the command', () => {
    expect(mcpDiagnostic({ type: 'stdio', command: 'uvx', args: [] })).toEqual({
      kind: 'command',
      value: 'uvx',
    })
  })

  it('quotes a command containing whitespace, not just its args', () => {
    expect(mcpDiagnostic({ type: 'stdio', command: 'C:\\Program Files\\node\\node.exe', args: ['server.js'] })).toEqual({
      kind: 'command',
      value: '"C:\\Program Files\\node\\node.exe" server.js',
    })
  })

  it('reports the URL for http / sse servers', () => {
    expect(mcpDiagnostic({ type: 'http', url: 'https://mcp.example.com/x' })).toEqual({
      kind: 'url',
      value: 'https://mcp.example.com/x',
    })
  })

  it('renders primitive args faithfully and drops null/objects rather than guessing', () => {
    expect(mcpDiagnostic({ type: 'stdio', command: 'node', args: ['server.js', 42, null, { x: 1 }] })).toEqual({
      kind: 'command',
      value: 'node server.js 42',
    })
  })

  it('quotes args containing whitespace so the pasted command survives a shell', () => {
    expect(mcpDiagnostic({ type: 'stdio', command: 'npx', args: ['-y', 'pkg', '--db', 'C:\\Users\\Ge Zelin\\db'] })).toEqual({
      kind: 'command',
      value: 'npx -y pkg --db "C:\\Users\\Ge Zelin\\db"',
    })
  })

  it('quotes empty args and escapes embedded double quotes', () => {
    expect(mcpDiagnostic({ type: 'stdio', command: 'node', args: ['', '--header', 'a "b" c'] })).toEqual({
      kind: 'command',
      value: 'node "" --header "a \\"b\\" c"',
    })
  })

  it('returns null for unknown config shapes', () => {
    expect(mcpDiagnostic(undefined)).toBeNull()
    expect(mcpDiagnostic(null)).toBeNull()
    expect(mcpDiagnostic('npx')).toBeNull()
    expect(mcpDiagnostic({ type: 'stdio' })).toBeNull()
    expect(mcpDiagnostic({ type: 'http' })).toBeNull()
  })
})
