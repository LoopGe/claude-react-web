import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createErrorHandler } from './errors.js'
import { buildBackgroundRouter } from './background-routes.js'
import { tempDir } from './__test-utils__/index.js'

function makeApp(dir: string, maxUploadBytes = 1024) {
  const app = new Hono()
  app.onError(createErrorHandler('[test]'))
  app.route('/api/background', buildBackgroundRouter({ dir, maxUploadBytes }))
  return app
}

describe('background routes', () => {
  let root: string
  let dir: string
  let app: Hono

  beforeEach(() => {
    root = tempDir('bg')
    dir = join(root, 'backgrounds')
    app = makeApp(dir)
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  describe('POST /api/background/upload', () => {
    it('writes an allowed image and returns its URL', async () => {
      const form = new FormData()
      form.append('file', new File(['fake-png'], 'wall.png', { type: 'image/png' }))
      const res = await app.request('/api/background/upload', { method: 'POST', body: form })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { url: string }
      expect(body.url).toMatch(/^\/api\/background\/files\/[0-9a-f-]+\.png$/)
      const name = body.url.split('/').pop()!
      expect(existsSync(join(dir, name))).toBe(true)
    })

    it('rejects a disallowed content type', async () => {
      const form = new FormData()
      form.append('file', new File(['x'], 'a.gif', { type: 'image/gif' }))
      const res = await app.request('/api/background/upload', { method: 'POST', body: form })
      expect(res.status).toBe(400)
    })

    it('writes an allowed video and returns its URL', async () => {
      const form = new FormData()
      form.append('file', new File(['fake-mp4'], 'loop.mp4', { type: 'video/mp4' }))
      const res = await app.request('/api/background/upload', { method: 'POST', body: form })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { url: string }
      expect(body.url).toMatch(/^\/api\/background\/files\/[0-9a-f-]+\.mp4$/)
      expect(existsSync(join(dir, body.url.split('/').pop()!))).toBe(true)
    })

    it('rejects a video container we do not serve (mov)', async () => {
      // .mov is Safari-only; accepting it would produce a wallpaper that
      // silently fails to play in every other browser.
      const form = new FormData()
      form.append('file', new File(['x'], 'a.mov', { type: 'video/quicktime' }))
      const res = await app.request('/api/background/upload', { method: 'POST', body: form })
      expect(res.status).toBe(400)
    })

    it('rejects a declared type that collides with Object.prototype', async () => {
      // `ALLOWED_UPLOAD[type]` is a prototype-chain lookup: 'constructor' would
      // resolve to Object (truthy) and sail past the allow-list, storing a file
      // whose name can never be served.
      const form = new FormData()
      form.append('file', new File(['x'], 'a', { type: 'constructor' }))
      const res = await app.request('/api/background/upload', { method: 'POST', body: form })
      expect(res.status).toBe(400)
    })

    it('rejects an over-size file (413)', async () => {
      const form = new FormData()
      form.append('file', new File([new Uint8Array(1025)], 'big.png', { type: 'image/png' }))
      const res = await app.request('/api/background/upload', { method: 'POST', body: form })
      expect(res.status).toBe(413)
    })
  })

  describe('GET /api/background/files/:name', () => {
    it('serves an uploaded file with its content type', async () => {
      const form = new FormData()
      form.append('file', new File(['fake-png'], 'wall.png', { type: 'image/png' }))
      const posted = (await (await app.request('/api/background/upload', { method: 'POST', body: form })).json()) as { url: string }
      const res = await app.request(posted.url)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
    })

    it('serves a video with its content type so the browser can play it', async () => {
      const form = new FormData()
      form.append('file', new File(['fake-mp4'], 'loop.mp4', { type: 'video/mp4' }))
      const posted = (await (await app.request('/api/background/upload', { method: 'POST', body: form })).json()) as { url: string }
      const res = await app.request(posted.url)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('video/mp4')
    })

    it('400s on a traversal / bad name', async () => {
      const res = await app.request('/api/background/files/..%2Fsecret.png')
      expect(res.status).toBe(400)
    })

    it('404s on a missing file', async () => {
      const res = await app.request('/api/background/files/00000000-0000-0000-0000-000000000000.png')
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/background/files/:name byte ranges', () => {
    // A <video> probes with `Range: bytes=0-` and refuses a resource that
    // answers 200 with no byte-range support (Safari in particular), so this
    // is what makes a video wallpaper play at all, not just a seek nicety.
    const BODY = '0123456789'

    async function uploadImage(): Promise<string> {
      const form = new FormData()
      form.append('file', new File([BODY], 'wall.png', { type: 'image/png' }))
      const posted = (await (await app.request('/api/background/upload', { method: 'POST', body: form })).json()) as { url: string }
      return posted.url
    }

    it('advertises byte-range support on an un-ranged response', async () => {
      const res = await app.request(await uploadImage())
      expect(res.status).toBe(200)
      expect(res.headers.get('accept-ranges')).toBe('bytes')
      expect(res.headers.get('content-length')).toBe(String(BODY.length))
      expect(await res.text()).toBe(BODY)
    })

    it('serves a closed range as 206', async () => {
      const res = await app.request(await uploadImage(), { headers: { Range: 'bytes=0-3' } })
      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe(`bytes 0-3/${BODY.length}`)
      expect(res.headers.get('accept-ranges')).toBe('bytes')
      expect(res.headers.get('content-length')).toBe('4')
      expect(await res.text()).toBe('0123')
    })

    it('runs an open-ended range to the end of the file', async () => {
      const res = await app.request(await uploadImage(), { headers: { Range: 'bytes=2-' } })
      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe(`bytes 2-9/${BODY.length}`)
      expect(await res.text()).toBe('23456789')
    })

    it('resolves a suffix range against the end of the file', async () => {
      const res = await app.request(await uploadImage(), { headers: { Range: 'bytes=-3' } })
      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe(`bytes 7-9/${BODY.length}`)
      expect(await res.text()).toBe('789')
    })

    it('clamps a range that overruns the end', async () => {
      const res = await app.request(await uploadImage(), { headers: { Range: 'bytes=8-999' } })
      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe(`bytes 8-9/${BODY.length}`)
      expect(await res.text()).toBe('89')
    })

    it('416s a range that starts past the end, reporting the size', async () => {
      const res = await app.request(await uploadImage(), { headers: { Range: 'bytes=99-' } })
      expect(res.status).toBe(416)
      expect(res.headers.get('content-range')).toBe(`bytes */${BODY.length}`)
    })

    it('answers a range it does not serve with the whole file', async () => {
      // Multi-range and unparseable headers may legally be answered in full;
      // a 206 we cannot honour is not an option.
      const url = await uploadImage()
      for (const Range of ['bytes=0-1,4-5', 'bytes=abc', 'items=0-1', 'bytes=-']) {
        const res = await app.request(url, { headers: { Range } })
        expect(res.status, `Range: ${Range}`).toBe(200)
        expect(await res.text()).toBe(BODY)
      }
    })

    it('ignores an invalid range rather than 416ing it', async () => {
      // RFC 9110: a byte-range-spec whose last-byte-pos precedes its
      // first-byte-pos is *invalid*, and an invalid Range must be ignored. Only
      // a well-formed range past the end is unsatisfiable. A 416 here can make
      // a media element give up on the resource altogether.
      const url = await uploadImage()
      for (const Range of ['bytes=5-3', 'bytes=99-2']) {
        const res = await app.request(url, { headers: { Range } })
        expect(res.status, `Range: ${Range}`).toBe(200)
        expect(await res.text()).toBe(BODY)
      }
    })

    it('416s an empty suffix range, which asks for zero bytes', async () => {
      const res = await app.request(await uploadImage(), { headers: { Range: 'bytes=-0' } })
      expect(res.status).toBe(416)
      expect(res.headers.get('content-range')).toBe(`bytes */${BODY.length}`)
    })

    it('streams a multi-chunk file, with a mid-file range off the real bytes', async () => {
      // A 10-byte fixture fits in one chunk and would hide a stream offset bug.
      // Its own app: the shared one caps uploads at 1 KiB.
      const bigApp = makeApp(dir, 200_000)
      const big = 'x'.repeat(50_000) + 'MARKER' + 'y'.repeat(50_000)
      const form = new FormData()
      form.append('file', new File([big], 'big.png', { type: 'image/png' }))
      const posted = (await (await bigApp.request('/api/background/upload', { method: 'POST', body: form })).json()) as { url: string }

      expect(await (await bigApp.request(posted.url)).text()).toBe(big)

      const res = await bigApp.request(posted.url, { headers: { Range: 'bytes=50000-50005' } })
      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe(`bytes 50000-50005/${big.length}`)
      expect(await res.text()).toBe('MARKER')
    })

    it('range-serves a video with its content type intact', async () => {
      const form = new FormData()
      form.append('file', new File(['fake-mp4'], 'loop.mp4', { type: 'video/mp4' }))
      const posted = (await (await app.request('/api/background/upload', { method: 'POST', body: form })).json()) as { url: string }
      const res = await app.request(posted.url, { headers: { Range: 'bytes=0-3' } })
      expect(res.status).toBe(206)
      expect(res.headers.get('content-type')).toBe('video/mp4')
      expect(await res.text()).toBe('fake')
    })
  })

  describe('DELETE /api/background/files/:name', () => {
    it('removes the file, then 404s on a second GET', async () => {
      const form = new FormData()
      form.append('file', new File(['fake-png'], 'wall.png', { type: 'image/png' }))
      const posted = (await (await app.request('/api/background/upload', { method: 'POST', body: form })).json()) as { url: string }
      const del = await app.request(posted.url, { method: 'DELETE' })
      expect(del.status).toBe(200)
      const again = await app.request(posted.url)
      expect(again.status).toBe(404)
    })

    it('404s deleting a missing file', async () => {
      const res = await app.request('/api/background/files/00000000-0000-0000-0000-000000000000.png', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })
  })
})
