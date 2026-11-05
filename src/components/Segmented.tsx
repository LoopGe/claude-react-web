// Compact segmented picker for small ordinal ranges.
//
// One implementation for both the settings modal (inline row) and the Theme
// popover's display presets (two-column grid variant), so their ARIA shape,
// active/disabled styling and re-click guard cannot drift.

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  labelFor,
  variant = 'inline',
}: {
  value: T
  options: readonly T[]
  onChange: (v: T) => void
  ariaLabel: string
  /** Optional display text; defaults to the raw value (numeric options). */
  labelFor?: (v: T) => string
  /** `grid` lays options out two per row: a four-item set becomes 2×2, and an
   *  odd-length set's final item spans both columns. */
  variant?: 'inline' | 'grid'
}) {
  return (
    <div
      className={variant === 'grid' ? 'segmented segmented-grid' : 'segmented'}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          role="radio"
          aria-checked={value === opt}
          className={`segmented-btn${value === opt ? ' active' : ''}`}
          onClick={() => {
            // Re-clicking the active option is a no-op, not a write.
            if (value !== opt) onChange(opt)
          }}
        >
          {labelFor ? labelFor(opt) : opt}
        </button>
      ))}
    </div>
  )
}