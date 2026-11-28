// Production-default wiring of the pane provider. Every other suite injects
// stub `providers`, which REPLACES the built-in list — so nothing else proves
// the upload provider is registered by default (without it, canOpen('upload')
// fails and the uploads-manager eye is silently dead) or that the tab-close
// observer maps an upload address to the upload-keyed PDF view state.
//
// store.open alone starts no stream (holders begin at subscribe/useResource),
// so these cases need no fetch stubs.

import { describe, it, expect, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { render } from '@testing-library/react'
import { ResourcePaneProvider } from './ResourcePaneProvider'
import { useResourcePaneStore } from './context'
import type { ResourcePaneStore } from './tab-store'
import { fileResource, uploadResource } from '../../shared/resource-address'
import {
  recallPdfViewState,
  rememberPdfPage,
  uploadViewStateKeyOf,
} from '../components/file-preview/pdf-view-state'

let store: ResourcePaneStore | null = null
function Probe() {
  const value = useResourcePaneStore()
  // Captured in an effect, not during render (react-hooks/globals; RTL's
  // render flushes effects before the assertions run).
  useEffect(() => {
    store = value
  })
  return null
}

beforeEach(() => {
  store = null
  window.localStorage.clear()
})

describe('ResourcePaneProvider production defaults', () => {
  it('registers the upload provider so an upload address opens with no injected providers', () => {
    render(
      <ResourcePaneProvider>
        <Probe />
      </ResourcePaneProvider>,
    )
    const result = store!.open('s-default', uploadResource({ id: 'u-1', name: 'a.txt', size: 10 }))
    expect(result.status).toBe('opened')
    expect(store!.getState('s-default').tabs[0]).toMatchObject({ kind: 'upload' })
  })

  it('closing an upload tab forgets the upload-keyed PDF view state', () => {
    render(
      <ResourcePaneProvider>
        <Probe />
      </ResourcePaneProvider>,
    )
    const opened = store!.open('s-close', uploadResource({ id: 'u-2', name: 'doc.pdf', size: 20 }))
    expect(opened.status).toBe('opened')
    if (opened.status === 'none') return // unreachable; narrows the union for the close below
    rememberPdfPage(uploadViewStateKeyOf('u-2'), 7)
    store!.close('s-close', opened.tabId)
    expect(recallPdfViewState(uploadViewStateKeyOf('u-2'))).toBeUndefined()
  })

  it('closing a file tab still forgets by the verbatim address', () => {
    render(
      <ResourcePaneProvider>
        <Probe />
      </ResourcePaneProvider>,
    )
    const address = fileResource('s-file', '/repo/x.pdf')
    const opened = store!.open('s-file', address)
    expect(opened.status).toBe('opened')
    if (opened.status === 'none') return
    rememberPdfPage(address, 3)
    store!.close('s-file', opened.tabId)
    expect(recallPdfViewState(address)).toBeUndefined()
  })
})
