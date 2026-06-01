// Lightweight skeleton placeholder for loading states.
//
// Renders shimmering bars so async sections (model lists, MCP servers,
// git branches/stashes, the session list) show a "content is coming"
// affordance instead of flashing an empty/"No items" message before data
// arrives. The shimmer respects prefers-reduced-motion (see styles.css —
// the animation is disabled there, leaving a static muted bar).

interface SkeletonProps {
  /** Number of placeholder rows to render. Default 3. */
  rows?: number
  /** Optional className applied to the wrapper for spacing tweaks. */
  className?: string
}

export function Skeleton({ rows = 3, className }: SkeletonProps) {
  return (
    <div
      className={`skeleton-group${className ? ` ${className}` : ''}`}
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading…"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" aria-hidden />
      ))}
    </div>
  )
}
