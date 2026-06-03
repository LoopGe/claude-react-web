// "Open on phone" settings tab — shows a QR code that encodes the LAN URL
// (with the access token baked in) so a phone on the same network can open
// the already-signed-in UI by scanning, instead of typing the token by hand.
//
// Data comes from GET /api/access-info, which only an already-authenticated
// client can read (the token is an httpOnly cookie, invisible to JS). When
// the server is bound to loopback the API reports lanReachable=false and we
// show a hint to restart with --host 0.0.0.0 instead of a useless QR.
//
// Rendered inside GlobalSettingsModal (the modal frame, Escape handling, and
// focus trap are owned by that parent). Lazy-loaded so the `qrcode` dependency
// stays out of the global-settings chunk until this tab is opened.

import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { api } from '../hooks/useApi'
import { useToast } from '../hooks/useToast'

interface AccessUrl {
  ip: string
  url: string
}

interface AccessInfo {
  authEnabled: boolean
  boundHost: string
  lanReachable: boolean
  port: number | null
  urls: AccessUrl[]
}

export function ShareTab() {
  const toast = useToast()
  const [info, setInfo] = useState<AccessInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedIp, setSelectedIp] = useState<string | null>(null)
  // Keyed by url so a stale QR from a previous selection is never shown
  // (we render only when qr.url === selectedUrl).
  const [qr, setQr] = useState<{ url: string; svg: string } | null>(null)
  const mounted = useRef(true)

  // Fetch access info on mount.
  useEffect(() => {
    mounted.current = true
    api
      .get<AccessInfo>('/access-info')
      .then((res) => {
        if (!mounted.current) return
        setInfo(res)
        setSelectedIp(res.urls[0]?.ip ?? null)
      })
      .catch((err: Error) => {
        if (mounted.current) setError(err.message || 'Failed to load access info')
      })
    return () => {
      mounted.current = false
    }
  }, [])

  const selectedUrl = info?.urls.find((u) => u.ip === selectedIp)?.url ?? null

  // Render the QR for the currently-selected URL as an SVG string.
  useEffect(() => {
    if (!selectedUrl) return
    let cancelled = false
    // Fixed dark-on-white colors (the same in both themes) so the code
    // always scans; the surrounding box uses --qr-bg for the quiet zone.
    QRCode.toString(selectedUrl, {
      type: 'svg',
      margin: 1,
      width: 220,
      color: { dark: '#0b0d11', light: '#ffffff' },
    })
      .then((out) => {
        if (!cancelled) setQr({ url: selectedUrl, svg: out })
      })
      .catch(() => {
        /* keep last good QR; render guard hides it if url changed */
      })
    return () => {
      cancelled = true
    }
  }, [selectedUrl])

  const svg = qr && qr.url === selectedUrl ? qr.svg : null

  const handleCopy = useCallback(() => {
    if (!selectedUrl) return
    navigator.clipboard?.writeText(selectedUrl).then(
      () => toast.info('Link copied'),
      () => toast.error('Copy failed'),
    )
  }, [selectedUrl, toast])

  return (
    <div className="share-tab">
      {error && <p className="share-tab-hint">{error}</p>}

      {!error && info && !info.lanReachable && (
        <p className="share-tab-hint">
          This server is only reachable on this machine. To let a phone on the
          same network scan and connect, restart with <code>--host 0.0.0.0</code>.
        </p>
      )}

      {!error && info && info.lanReachable && info.urls.length === 0 && (
        <p className="share-tab-hint">
          No LAN network address was found. Make sure this machine is on a
          Wi-Fi / Ethernet network.
        </p>
      )}

      {!error && info && info.lanReachable && selectedUrl && (
        <>
          <p className="share-tab-hint">
            Scan with your phone&apos;s camera to open the UI — already signed
            in.
          </p>
          <div className="share-tab-qr">
            {svg ? (
              <div
                className="share-tab-qr-img"
                // QRCode.toString(svg) returns trusted, self-generated markup
                // (no user input) — safe to inject. Conditional render (not a
                // null dangerouslySetInnerHTML) so switching IPs replaces the
                // node instead of leaving the previous QR in the DOM.
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : (
              <div className="share-tab-qr-img" aria-hidden />
            )}
          </div>

          {info.urls.length > 1 && (
            <label className="share-tab-select">
              Network address
              <select
                className="input"
                value={selectedIp ?? ''}
                onChange={(e) => setSelectedIp(e.target.value)}
              >
                {info.urls.map((u) => (
                  <option key={u.ip} value={u.ip}>
                    {u.ip}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="share-tab-url-row">
            <div className="share-tab-url">
              <code>{selectedUrl}</code>
            </div>
            <button type="button" className="btn" onClick={handleCopy}>
              Copy
            </button>
          </div>

          <p className="share-tab-warn">
            Anyone on your network with this link gets full access. Keep it
            private.
          </p>
        </>
      )}

      {!error && !info && <p className="share-tab-hint">Loading…</p>}
    </div>
  )
}
