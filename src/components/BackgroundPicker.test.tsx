import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { BackgroundPicker } from './BackgroundPicker'
import type { BackgroundSetting } from '../theme'

function setting(pref: BackgroundSetting['pref'], opacity = 0.85): BackgroundSetting {
  return { pref, opacity }
}

describe('BackgroundPicker', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders None/Custom and defaults to None active', () => {
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={() => {}} />)
    expect(screen.getByRole('radio', { name: 'None' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Custom image' })).toBeTruthy()
  })

  it('applies a valid http(s) URL on submit', () => {
    const onChange = vi.fn()
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Custom image' }))
    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: 'https://ex.com/bg.png' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use URL' }))
    expect(onChange).toHaveBeenCalledWith({ pref: { kind: 'custom', src: 'https://ex.com/bg.png' }, opacity: 0.85 })
  })

  it('rejects a non-http(s) URL', () => {
    const onChange = vi.fn()
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Custom image' }))
    onChange.mockClear()
    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: 'file:///etc/passwd' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use URL' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('uploads a file and applies the returned URL, deleting the old file', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: '/api/background/files/new.png' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // DELETE old
    vi.stubGlobal('fetch', fetchMock)
    const onChange = vi.fn()
    render(<BackgroundPicker setting={setting({ kind: 'custom', src: '/api/background/files/old.png' }, 0.7)} onChange={onChange} />)
    fireEvent.click(screen.getByText('Upload image…'))
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } })
    await screen.findByText('Applied')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledWith({ pref: { kind: 'custom', src: '/api/background/files/new.png' }, opacity: 0.7 })
  })

  it('Clear resets to none and deletes a previous uploaded file', () => {
    const onChange = vi.fn()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    render(<BackgroundPicker setting={setting({ kind: 'custom', src: '/api/background/files/old.png' })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onChange).toHaveBeenCalledWith({ pref: { kind: 'none' }, opacity: 0.85 })
    expect(fetchMock).toHaveBeenCalledWith('/api/background/files/old.png', { method: 'DELETE' })
  })
})
