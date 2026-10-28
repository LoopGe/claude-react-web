/**
 * Where the live turn's text renders while a reply streams.
 *
 * Single home of the union — three consumers alias this type so a third
 * value (e.g. an 'off' mode that shows no live preview) flows everywhere
 * automatically:
 *  - the renderer's `StreamingFooterVariant` (transcript-chrome.tsx — where
 *    the footer mounts),
 *  - the `MessageList` mode seam (`StreamingRenderMode` / the
 *    `streamingMode` prop),
 *  - the global config field (`streamingRenderMode` in config.json).
 *
 * 'overlay' (default): the capped floating bubble in `.chat-bottom-stack`.
 * 'inline': an in-flow tail row at the end of the Virtuoso list — grows with
 * the turn, scrolls with the transcript, scrollable back through (the
 * card-era feel).
 */

export type StreamingRenderMode = 'overlay' | 'inline'

/** Display order for any future picker control; also the guard's source. */
export const STREAMING_RENDER_MODES: readonly StreamingRenderMode[] = ['overlay', 'inline']

/** The app ships with the floating bubble. Flipping this is a product
 *  decision, not an accident. */
export const DEFAULT_STREAMING_RENDER_MODE: StreamingRenderMode = 'overlay'

/** Runtime type guard for values read from config.json / the PUT body. */
export function isStreamingRenderMode(v: unknown): v is StreamingRenderMode {
  return typeof v === 'string' && (STREAMING_RENDER_MODES as readonly string[]).includes(v)
}
