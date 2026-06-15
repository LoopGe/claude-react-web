import { describe, it, expect } from 'vitest'
import { isReadOnlyBash } from './readonly-bash.js'

describe('isReadOnlyBash — allowed (read-only)', () => {
  it('approves known read-only commands', () => {
    for (const c of ['ls', 'ls -la', 'cat a.txt', 'echo hi', 'pwd', 'head -n5 f',
      'tail f', 'grep foo f', 'wc -l f', 'which node', 'diff a b', 'stat f',
      'du -sh', 'cd src']) {
      expect(isReadOnlyBash(c)).toBe(true)
    }
  })

  it('approves read-only git subcommands', () => {
    expect(isReadOnlyBash('git status')).toBe(true)
    expect(isReadOnlyBash('git log --oneline')).toBe(true)
    expect(isReadOnlyBash('git diff HEAD')).toBe(true)
    expect(isReadOnlyBash('git show')).toBe(true)
    expect(isReadOnlyBash('git rev-parse HEAD')).toBe(true)
    expect(isReadOnlyBash('git branch')).toBe(true)
    expect(isReadOnlyBash('git branch -a')).toBe(true)
    expect(isReadOnlyBash('git tag --list')).toBe(true)
    expect(isReadOnlyBash('git remote -v')).toBe(true)
    expect(isReadOnlyBash('git remote show origin')).toBe(true)
    expect(isReadOnlyBash('git remote get-url origin')).toBe(true)
  })

  it('strips safe wrappers and env prefixes', () => {
    expect(isReadOnlyBash('LANG=C ls')).toBe(true)
    expect(isReadOnlyBash('timeout cat f')).toBe(true)
    expect(isReadOnlyBash('nice grep x f')).toBe(true)
  })
})

describe('isReadOnlyBash — denied (fail-closed)', () => {
  it('denies non-string / empty', () => {
    expect(isReadOnlyBash(undefined)).toBe(false)
    expect(isReadOnlyBash('')).toBe(false)
    expect(isReadOnlyBash('   ')).toBe(false)
  })

  it('denies write/exec commands', () => {
    for (const c of ['rm f', 'mv a b', 'cp a b', 'mkdir d', 'touch f',
      'node x.js', 'npm install', 'curl http://x', 'chmod +x f', 'sed -i s/x/y/ f']) {
      expect(isReadOnlyBash(c)).toBe(false)
    }
  })

  it('denies write git subcommands', () => {
    expect(isReadOnlyBash('git commit -m x')).toBe(false)
    expect(isReadOnlyBash('git push')).toBe(false)
    expect(isReadOnlyBash('git checkout main')).toBe(false)
    expect(isReadOnlyBash('git reset --hard')).toBe(false)
    expect(isReadOnlyBash('git clean -fd')).toBe(false)
    expect(isReadOnlyBash('git config user.name x')).toBe(false) // writes .git/config
    expect(isReadOnlyBash('git branch new-feature')).toBe(false)
    expect(isReadOnlyBash('git branch -D old-feature')).toBe(false)
    expect(isReadOnlyBash('git tag v1.0.0')).toBe(false)
    expect(isReadOnlyBash('git tag -d v1.0.0')).toBe(false)
    expect(isReadOnlyBash('git remote add origin https://example.com/repo.git')).toBe(false)
    expect(isReadOnlyBash('git diff --output=patch.diff HEAD')).toBe(false)
    expect(isReadOnlyBash('git')).toBe(false) // bare git
  })

  it('denies anything with shell features (smuggling)', () => {
    expect(isReadOnlyBash('cat f | sh')).toBe(false)
    expect(isReadOnlyBash('echo x > file')).toBe(false)
    expect(isReadOnlyBash('ls && rm x')).toBe(false)
    expect(isReadOnlyBash('cat $(rm x)')).toBe(false)
    expect(isReadOnlyBash('cat `rm x`')).toBe(false)
    expect(isReadOnlyBash('ls; rm x')).toBe(false)
    expect(isReadOnlyBash('grep "a b" f')).toBe(false) // quotes
    expect(isReadOnlyBash('ls *.ts')).toBe(false) // glob (conservative)
  })

  it('denies find (excluded due to -exec/-delete)', () => {
    expect(isReadOnlyBash('find . -name x')).toBe(false)
    expect(isReadOnlyBash('find . -delete')).toBe(false)
  })
})
