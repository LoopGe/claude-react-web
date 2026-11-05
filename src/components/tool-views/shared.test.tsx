// @vitest-environment happy-dom
// FilePathTitle's open-preview button: null-safe without a link context,
// resolves the file address from the session cwd, forwards line params; and
// Read's 0-based offset → 1-based line mapping.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { FilePathTitle, readLineParams } from './shared'
import { SessionCwdProvider } from '../../hooks/useSessionCwd'
import { parseFileResource } from '../../../shared/resource-address'

const linkState = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }))
vi.mock('../../resources/ResourceLinkContext', () => ({
  useResourceLinkContext: () => linkState.value,
}))

const openResource = vi.fn()

beforeEach(() => {
  openResource.mockClear()
  linkState.value = { sessionId: 's1', baseDir: '/repo', openResource }
})

function renderTitle(params?: Record<string, number>) {
  return render(
    <SessionCwdProvider value="/repo">
      <FilePathTitle path="src/a.ts" params={params} />
    </SessionCwdProvider>,
  )
}

describe('FilePathTitle open preview', () => {
  it('renders no open button without a link context', () => {
    linkState.value = null
    const { container } = renderTitle()
    expect(container.querySelector('.tool-card-filepath-open')).toBeNull()
    expect(container.querySelector('.tool-card-filepath')).not.toBeNull()
  })

  it('opens the resolved file resource', () => {
    renderTitle()
    fireEvent.click(document.querySelector('.tool-card-filepath-open') as HTMLElement)
    expect(openResource).toHaveBeenCalledTimes(1)
    const [sessionId, address, options] = openResource.mock.calls[0]
    expect(sessionId).toBe('s1')
    expect(parseFileResource(address)).toEqual({ sessionId: 's1', path: '/repo/src/a.ts' })
    expect(options).toBeUndefined()
  })

  it('forwards navigation params', () => {
    renderTitle({ line: 11, endLine: 20 })
    fireEvent.click(document.querySelector('.tool-card-filepath-open') as HTMLElement)
    expect(openResource.mock.calls[0][2]).toEqual({ params: { line: 11, endLine: 20 } })
  })
})

describe('readLineParams', () => {
  it('maps a 0-based offset/limit to 1-based line params', () => {
    expect(readLineParams(10, 5)).toEqual({ line: 11, endLine: 15 })
    expect(readLineParams(10, null)).toEqual({ line: 11, endLine: undefined })
    expect(readLineParams(null, 5)).toBeUndefined()
  })
})