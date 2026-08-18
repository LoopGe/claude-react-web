import { describe, it, expect } from 'vitest'
import { resolve, join } from 'node:path'
import {
  isAutoApprovableEditBash,
  isAutoApprovableEditPath,
  isInScopeRelativePath,
  isInScopePath,
  isInScopeEditTool,
  isSensitiveAutoEditPath,
} from './accept-edits-bash.js'

describe('isAutoApprovableEditBash ?allowed', () => {
  it('approves bare whitelisted commands on relative paths', () => {
    expect(isAutoApprovableEditBash('mkdir foo')).toBe(true)
    expect(isAutoApprovableEditBash('touch src/a.txt')).toBe(true)
    expect(isAutoApprovableEditBash('rm build/out.js')).toBe(true)
    expect(isAutoApprovableEditBash('rmdir tmp')).toBe(true)
    expect(isAutoApprovableEditBash('mv a/b.txt a/c.txt')).toBe(true)
    expect(isAutoApprovableEditBash('cp src/a.txt src/b.txt')).toBe(true)
  })

  it('never approves sed (excluded: its script arg is an RCE/arbitrary-write vector)', () => {
    // Even a benign-looking sed prompts, by design.
    expect(isAutoApprovableEditBash('sed -i notes.md')).toBe(false)
    // The dangerous forms it protects against (would be RCE / arbitrary write
    // if sed were whitelisted and its script treated as a path):
    expect(isAutoApprovableEditBash('sed e notes.md')).toBe(false)
  })

  it('allows flags', () => {
    expect(isAutoApprovableEditBash('mkdir -p foo/bar')).toBe(true)
    expect(isAutoApprovableEditBash('rm -r build')).toBe(true)
    expect(isAutoApprovableEditBash('rm --recursive build')).toBe(true)
    expect(isAutoApprovableEditBash('cp -R a b')).toBe(true)
  })

  it('allows safe env prefixes and wrappers', () => {
    expect(isAutoApprovableEditBash('LANG=C mkdir foo')).toBe(true)
    expect(isAutoApprovableEditBash('NO_COLOR=1 touch a.txt')).toBe(true)
    expect(isAutoApprovableEditBash('nice mkdir foo')).toBe(true)
    expect(isAutoApprovableEditBash('timeout nice rm build')).toBe(true)
  })

  it('allows command with no path args (e.g. mkdir with only a name token)', () => {
    expect(isAutoApprovableEditBash('mkdir dist')).toBe(true)
  })
})

describe('isAutoApprovableEditBash ?denied (fail-closed)', () => {
  it('denies non-string / empty', () => {
    expect(isAutoApprovableEditBash(undefined)).toBe(false)
    expect(isAutoApprovableEditBash(null)).toBe(false)
    expect(isAutoApprovableEditBash(123)).toBe(false)
    expect(isAutoApprovableEditBash('')).toBe(false)
    expect(isAutoApprovableEditBash('   ')).toBe(false)
  })

  it('denies non-whitelisted commands', () => {
    expect(isAutoApprovableEditBash('cat foo')).toBe(false)
    expect(isAutoApprovableEditBash('curl http://x')).toBe(false)
    expect(isAutoApprovableEditBash('node script.js')).toBe(false)
    expect(isAutoApprovableEditBash('git commit')).toBe(false)
  })

  it('denies pipes, redirects, chaining, substitution', () => {
    expect(isAutoApprovableEditBash('rm a | rm b')).toBe(false)
    expect(isAutoApprovableEditBash('rm a > out')).toBe(false)
    expect(isAutoApprovableEditBash('rm a && rm b')).toBe(false)
    expect(isAutoApprovableEditBash('rm a; rm b')).toBe(false)
    expect(isAutoApprovableEditBash('rm $(echo b)')).toBe(false)
    expect(isAutoApprovableEditBash('rm `echo b`')).toBe(false)
    expect(isAutoApprovableEditBash('rm a || rm b')).toBe(false)
  })

  it('denies absolute paths, home, traversal', () => {
    expect(isAutoApprovableEditBash('rm /etc/passwd')).toBe(false)
    expect(isAutoApprovableEditBash('rm -rf /')).toBe(false)
    expect(isAutoApprovableEditBash('rm ~/secrets')).toBe(false)
    expect(isAutoApprovableEditBash('rm ../outside')).toBe(false)
    expect(isAutoApprovableEditBash('mv a ../../b')).toBe(false)
    expect(isAutoApprovableEditBash('rm C:\\\\Windows')).toBe(false)
  })

  it('denies globs and quotes (smuggling vectors)', () => {
    expect(isAutoApprovableEditBash('rm *')).toBe(false)
    expect(isAutoApprovableEditBash('rm build/*.js')).toBe(false)
    expect(isAutoApprovableEditBash('rm "a b"')).toBe(false)
    expect(isAutoApprovableEditBash("rm 'a'")).toBe(false)
    expect(isAutoApprovableEditBash('rm a?')).toBe(false)
    expect(isAutoApprovableEditBash('rm {a,b}')).toBe(false)
  })

  it('denies env-prefix abuse and unknown wrappers', () => {
    expect(isAutoApprovableEditBash('PATH=/evil rm a')).toBe(false) // value has '/'
    expect(isAutoApprovableEditBash('FOO=$(x) rm a')).toBe(false)
    expect(isAutoApprovableEditBash('sudo rm a')).toBe(false)
    expect(isAutoApprovableEditBash('env rm a')).toBe(false)
  })

  it('denies a wrapper with no following command', () => {
    expect(isAutoApprovableEditBash('timeout')).toBe(false)
    expect(isAutoApprovableEditBash('LANG=C')).toBe(false)
  })

  it('denies flags with attached values because they may hide paths', () => {
    expect(isAutoApprovableEditBash('cp a --target-directory=C:/Windows')).toBe(false)
    expect(isAutoApprovableEditBash('mv a --target-directory=/tmp')).toBe(false)
    expect(isAutoApprovableEditBash('touch --reference=C:/Windows/win.ini a')).toBe(false)
    expect(isAutoApprovableEditBash('mkdir --mode=755 a')).toBe(false)
  })

  it('denies sensitive config paths even when they are relative', () => {
    expect(isAutoApprovableEditBash('rm .git/config')).toBe(false)
    expect(isAutoApprovableEditBash('touch .claude/settings.json')).toBe(false)
    expect(isAutoApprovableEditBash('mkdir .vscode')).toBe(false)
    expect(isAutoApprovableEditBash('touch .bashrc')).toBe(false)
  })
})

describe('isInScopeRelativePath', () => {
  it('accepts plain relative paths', () => {
    expect(isInScopeRelativePath('a.txt')).toBe(true)
    expect(isInScopeRelativePath('src/a/b.txt')).toBe(true)
    expect(isInScopeRelativePath('./a.txt')).toBe(true)
  })
  it('rejects absolute / home / traversal', () => {
    expect(isInScopeRelativePath('/etc')).toBe(false)
    expect(isInScopeRelativePath('~/x')).toBe(false)
    expect(isInScopeRelativePath('../x')).toBe(false)
    expect(isInScopeRelativePath('a/../../b')).toBe(false)
    expect(isInScopeRelativePath('C:/Windows')).toBe(false)
    expect(isInScopeRelativePath('\\\\server\\share')).toBe(false)
    expect(isInScopeRelativePath('')).toBe(false)
  })
})

describe('isInScopePath (cwd-aware)', () => {
  const cwd = resolve('/projects/app') // normalized per-platform

  it('accepts relative paths inside cwd', () => {
    expect(isInScopePath('a.txt', cwd)).toBe(true)
    expect(isInScopePath('src/a/b.txt', cwd)).toBe(true)
    expect(isInScopePath('./a.txt', cwd)).toBe(true)
    expect(isInScopePath('.', cwd)).toBe(true)
  })

  it('accepts ABSOLUTE paths that resolve inside cwd (official semantics)', () => {
    expect(isInScopePath(join(cwd, 'src', 'x.ts'), cwd)).toBe(true)
    expect(isInScopePath(join(cwd, 'deep', 'nested', 'f'), cwd)).toBe(true)
  })

  it('rejects absolute paths outside cwd', () => {
    expect(isInScopePath(resolve('/etc/passwd'), cwd)).toBe(false)
    expect(isInScopePath(resolve('/projects/other/x'), cwd)).toBe(false)
    // prefix sibling must NOT pass (the /foo vs /foobar trap)
    expect(isInScopePath(resolve('/projects/app-evil/x'), cwd)).toBe(false)
  })

  it('rejects relative traversal that escapes cwd', () => {
    expect(isInScopePath('../outside', cwd)).toBe(false)
    expect(isInScopePath('a/../../b', cwd)).toBe(false)
  })

  it('rejects ~ even with cwd (cannot resolve home safely)', () => {
    expect(isInScopePath('~/secrets', cwd)).toBe(false)
  })

  it('without cwd falls back to relative-only (absolute rejected)', () => {
    expect(isInScopePath('a.txt')).toBe(true)
    expect(isInScopePath('/etc', undefined)).toBe(false)
  })
})

describe('isInScopeEditTool', () => {
  const cwd = resolve('/work/app')
  const fwd = (p: string) => p.replace(/\\/g, '/')

  it('accepts edit tools targeting paths inside cwd', () => {
    expect(isInScopeEditTool('Write', { file_path: fwd(join(cwd, 'a.txt')) }, cwd)).toBe(true)
    expect(isInScopeEditTool('Edit', { file_path: fwd(join(cwd, 'src/x.ts')) }, cwd)).toBe(true)
    expect(isInScopeEditTool('MultiEdit', { file_path: fwd(join(cwd, 'x')) }, cwd)).toBe(true)
    expect(isInScopeEditTool('NotebookEdit', { notebook_path: fwd(join(cwd, 'nb.ipynb')) }, cwd)).toBe(true)
    expect(isInScopeEditTool('Write', { file_path: 'rel.txt' }, cwd)).toBe(true)
  })

  it('rejects edit tools targeting paths outside cwd', () => {
    expect(isInScopeEditTool('Write', { file_path: resolve('/etc/passwd') }, cwd)).toBe(false)
    expect(isInScopeEditTool('Edit', { file_path: '../outside.ts' }, cwd)).toBe(false)
    expect(isInScopeEditTool('NotebookEdit', { notebook_path: resolve('/other/nb.ipynb') }, cwd)).toBe(false)
  })

  it('rejects sensitive config paths inside cwd', () => {
    expect(isInScopeEditTool('Write', { file_path: fwd(join(cwd, '.git/config')) }, cwd)).toBe(false)
    expect(isInScopeEditTool('Write', { file_path: fwd(join(cwd, '.claude/settings.json')) }, cwd)).toBe(false)
    expect(isInScopeEditTool('Write', { file_path: fwd(join(cwd, '.vscode/settings.json')) }, cwd)).toBe(false)
    expect(isInScopeEditTool('Write', { file_path: fwd(join(cwd, '.bashrc')) }, cwd)).toBe(false)
  })

  it('does not confuse similarly name safe paths with sensitive dirs', () => {
    expect(isInScopeEditTool('Write', { file_path: fwd(join(cwd, '.gitignore')) }, cwd)).toBe(true)
    expect(isInScopeEditTool('Write', { file_path: fwd(join(cwd, '.claude-plugin/manifest.json')) }, cwd)).toBe(true)
  })

  it('fail-closed on unknown tool / missing / non-string path', () => {
    expect(isInScopeEditTool('Bash', { command: 'rm x' }, cwd)).toBe(false)
    expect(isInScopeEditTool('Write', {}, cwd)).toBe(false)
    expect(isInScopeEditTool('Write', { file_path: 123 }, cwd)).toBe(false)
    expect(isInScopeEditTool('Write', null, cwd)).toBe(false)
    // NotebookEdit reads notebook_path, not file_path → missing → false
    expect(isInScopeEditTool('NotebookEdit', { file_path: fwd(join(cwd, 'x')) }, cwd)).toBe(false)
  })

  it('without cwd, accepts only relative paths', () => {
    expect(isInScopeEditTool('Write', { file_path: 'a.txt' })).toBe(true)
    expect(isInScopeEditTool('Write', { file_path: '/etc/x' })).toBe(false)
  })
})

describe('sensitive acceptEdits paths', () => {
  const cwd = resolve('/projects/app')

  it('detects sensitive dirs and shell profile files component-wise', () => {
    expect(isSensitiveAutoEditPath(join(cwd, '.git/config'), cwd)).toBe(true)
    expect(isSensitiveAutoEditPath(join(cwd, '.claude/settings.json'), cwd)).toBe(true)
    expect(isSensitiveAutoEditPath(join(cwd, '.vscode/settings.json'), cwd)).toBe(true)
    expect(isSensitiveAutoEditPath(join(cwd, '.config/fish/config.fish'), cwd)).toBe(true)
    expect(isSensitiveAutoEditPath(join(cwd, 'Microsoft.PowerShell_profile.ps1'), cwd)).toBe(true)
  })

  it('keeps ordinary project files auto-approvable', () => {
    expect(isAutoApprovableEditPath(join(cwd, 'src/app.ts'), cwd)).toBe(true)
    expect(isAutoApprovableEditPath(join(cwd, '.gitignore'), cwd)).toBe(true)
    expect(isAutoApprovableEditPath(join(cwd, '.claude-plugin/manifest.json'), cwd)).toBe(true)
  })

  it('allowSensitive=true relaxes the sensitive-path exclusion but still requires in-scope', () => {
    // Sensitive in-cwd paths become auto-approvable.
    expect(isAutoApprovableEditPath(join(cwd, '.claude/settings.json'), cwd, true)).toBe(true)
    expect(isAutoApprovableEditPath(join(cwd, '.git/config'), cwd, true)).toBe(true)
    // Out-of-cwd paths still rejected even with the opt-in.
    expect(isAutoApprovableEditPath('/etc/passwd', cwd, true)).toBe(false)
    // Without the opt-in, sensitive paths still prompt (default behavior).
    expect(isAutoApprovableEditPath(join(cwd, '.claude/settings.json'), cwd)).toBe(false)
  })

  it('isInScopeEditTool threads allowSensitive through', () => {
    const fwd = (p: string) => p.replace(/\\/g, '/')
    expect(isInScopeEditTool('Write', { file_path: fwd(join(cwd, '.claude/settings.json')) }, cwd)).toBe(false)
    expect(isInScopeEditTool('Write', { file_path: fwd(join(cwd, '.claude/settings.json')) }, cwd, true)).toBe(true)
  })
})

describe('isAutoApprovableEditBash with cwd', () => {
  const cwd = resolve('/projects/app')
  // Bash commands use forward slashes even on Windows; backslashes are shell
  // escapes and are (correctly) rejected by the metacharacter gate. Build the
  // command path with forward slashes to reflect real Bash usage.
  const fwd = (p: string) => p.replace(/\\/g, '/')
  it('approves whitelisted command on absolute path inside cwd', () => {
    expect(isAutoApprovableEditBash(`touch ${fwd(join(cwd, 'x.txt'))}`, cwd)).toBe(true)
  })
  it('still prompts for absolute path outside cwd', () => {
    expect(isAutoApprovableEditBash('rm /etc/passwd', cwd)).toBe(false)
    expect(isAutoApprovableEditBash('rm -rf /', cwd)).toBe(false)
  })
})
