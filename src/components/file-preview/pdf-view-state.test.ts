// @vitest-environment happy-dom
/** Per-(session,file) PDF view-state retention: survives body unmounts, forgotten on close. */
import { afterEach, describe, expect, it } from 'vitest'
import { forgetPdfViewState, recallPdfViewState, rememberPdfPage, rememberPdfZoom } from './pdf-view-state'

const KEY = 'crw-resource://file/s1/repo/report.pdf'
const OTHER = 'crw-resource://file/s1/repo/other.pdf'

afterEach(() => {
  forgetPdfViewState(KEY)
  forgetPdfViewState(OTHER)
})

describe('pdf view-state store', () => {
  it('recalls nothing for an unremembered key', () => {
    expect(recallPdfViewState(KEY)).toBeUndefined()
  })

  it('remembers the reached page and the settled zoom independently', () => {
    rememberPdfPage(KEY, 3)
    expect(recallPdfViewState(KEY)).toEqual({ page: 3 })
    rememberPdfZoom(KEY, 1.5)
    expect(recallPdfViewState(KEY)).toEqual({ page: 3, zoom: 1.5 })
    rememberPdfPage(KEY, 4)
    expect(recallPdfViewState(KEY)).toEqual({ page: 4, zoom: 1.5 })
  })

  it('a fit-width selection clears the fixed zoom but keeps the page', () => {
    rememberPdfPage(KEY, 2)
    rememberPdfZoom(KEY, 2)
    rememberPdfZoom(KEY, undefined)
    expect(recallPdfViewState(KEY)).toEqual({ page: 2 })
  })

  it('defaults the page to 1 when only a zoom is remembered', () => {
    rememberPdfZoom(KEY, 0.5)
    expect(recallPdfViewState(KEY)).toEqual({ page: 1, zoom: 0.5 })
  })

  it('isolates keys and forgets one without touching the other', () => {
    rememberPdfPage(KEY, 5)
    rememberPdfPage(OTHER, 2)
    forgetPdfViewState(KEY)
    expect(recallPdfViewState(KEY)).toBeUndefined()
    expect(recallPdfViewState(OTHER)).toEqual({ page: 2 })
  })

  it('forgetting an unremembered key is a no-op', () => {
    expect(() => forgetPdfViewState(KEY)).not.toThrow()
  })
})
