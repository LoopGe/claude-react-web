/**
 * Where the live turn's text renders while a reply streams.
 *
 * Single home of the union — the consumers alias this type so a third
 * value (e.g. an 'off' mode that shows no live preview) flows everywhere
 * automatically:
 *  - the `MessageList` mode seam (`streamingMode` prop),
 *  - the global config field (`streamingRenderMode` in config.json).
 *  (The renderer's `StreamingFooterVariant` alias retired with the inline
 *  footer — the overlay bubble is footer-only now.)
 *
 * 'inline' (default): the message card grows in place at the end of the
 * transcript — the live text streams straight into a real card that settles in
 * place with no swap (see
 * docs/superpowers/specs/2026-10-28-inplace-streaming-card-design.md).
 * 'overlay': the capped floating bubble in `.chat-bottom-stack`.
 */

export type StreamingRenderMode = 'overlay' | 'inline'

/** Display order for any future picker control; also the guard's source. */
export const STREAMING_RENDER_MODES: readonly StreamingRenderMode[] = ['overlay', 'inline']

/** The app ships with the inline growing card. Flipping this is a product
 *  decision, not an accident. */
export const DEFAULT_STREAMING_RENDER_MODE: StreamingRenderMode = 'inline'

/** Runtime type guard for values read from config.json / the PUT body. */
export function isStreamingRenderMode(v: unknown): v is StreamingRenderMode {
  return typeof v === 'string' && (STREAMING_RENDER_MODES as readonly string[]).includes(v)
}
