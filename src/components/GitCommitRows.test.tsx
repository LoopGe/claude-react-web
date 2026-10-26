import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { GitCommitResponse, GitDiff, GitRangeFile } from '../../shared/git-types'

// CommitRow drives its file list through useCachedCommitFiles → useGitCommitFiles
// and each row's diff through useGitCommitDiffFile; both go through api.get.
const mockGet = vi.fn()
vi.mock('../hooks/useApi', () => ({
  api: { get: (...args: unknown[]) => mockGet(...args), post: vi.fn() },
}))

import { CommitRow } from './GitCommitRows'
import { isWriteKeyInert } from './GitPanel'

const HASH = 'a'.repeat(40)

const oneFile: GitRangeFile = { path: 'a.txt', status: 'M', insertions: 1, deletions: 1 }

const diffFixture: GitDiff = {
  path: 'a.txt',
  staged: false,
  truncated: false,
  totalLines: 3,
  text: '@@ -1 +1 @@\n-alpha\n+beta\n',
  isBinary: false,
}

function commitResponse(files: GitRangeFile[], body = ''): GitCommitResponse {
  return {
    commit: { hash: HASH, shortHash: HASH.slice(0, 7), author: 'T', date: 1, subject: 'second', body },
    files,
  }
}

/** Route api.get by path: /git/commit → the commit detail, /git/commit-file → a diff. */
function mockCommitApis(files: GitRangeFile[], body = '') {
  mockGet.mockImplementation((url: string) => {
    if (url.startsWith('/git/commit?')) return Promise.resolve(commitResponse(files, body))
    if (url.startsWith('/git/commit-file?')) return Promise.resolve(diffFixture)
    return Promise.reject(new Error(`unexpected url ${url}`))
  })
}

function renderRow(overrides: Partial<Parameters<typeof CommitRow>[0]> = {}) {
  return render(
    <CommitRow
      cwd="/repo"
      hash={HASH}
      subject="second"
      author="T"
      date={1}
      body=""
      expanded={false}
      onToggle={() => {}}
      cache={new Map()}
      selectedPath={null}
      onSelectFile={() => {}}
      {...overrides}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCommitApis([oneFile])
})

describe('CommitRow', () => {
  it('expands a commit to its file rows and expands a file to its diff', async () => {
    // api.get: /git/commit?… → fixture with one file 'a.txt'
    //          /git/commit-file?… → { path, staged: false, truncated: false, totalLines: 3, text: '@@ -1 +1 @@\n-alpha\n+beta\n', isBinary: false }
    renderRow()
    fireEvent.click(screen.getByText('second'))
    // findByText throws unless the node is in the document — toBeTruthy
    // makes the assertion explicit (this repo has no jest-dom matchers).
    expect(await screen.findByText('a.txt')).toBeTruthy()
    fireEvent.click(screen.getByText('a.txt'))
    // DiffView splits each line into a sign column ('+') and a body ('beta'),
    // and Testing Library's text matcher only reads an element's DIRECT text
    // nodes — so no element's text is the composite '+beta'. Assert the add
    // line's body, which is the half of '+beta' the row renders as text.
    expect(await screen.findByText('beta')).toBeTruthy()
  })

  it('shows the empty copy for a commit with no file changes', async () => {
    mockCommitApis([])
    renderRow()
    fireEvent.click(screen.getByText('second'))
    expect(await screen.findByText('No file changes in this commit.')).toBeTruthy()
  })

  it('renders the commit body under the row once open', async () => {
    mockCommitApis([oneFile], 'extra detail here')
    renderRow()
    fireEvent.click(screen.getByText('second'))
    expect(await screen.findByText('extra detail here')).toBeTruthy()
  })
})

describe('isWriteKeyInert', () => {
  it('write keys do not fire on commit file rows', () => {
    expect(isWriteKeyInert('commit-file')).toBe(true)
    expect(isWriteKeyInert('unstaged')).toBe(false)
    expect(isWriteKeyInert('staged')).toBe(false)
    expect(isWriteKeyInert('untracked')).toBe(false)
  })
})
