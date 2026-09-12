/** Inline SVG sparkline for a series of sampled values (oldest → newest).
 *  Y is scaled to the sample range (not a fixed axis) — the shape is the
 *  signal, the absolute value lives in the table cells next to it. A small
 *  hot dot marks the latest sample when it exceeds `hotAbove`. No chart
 *  library: a single polyline in a fixed-viewBox SVG. */
export function PerfSparkline({ values, hotAbove }: { values: number[]; hotAbove?: number }) {
  if (values.length < 2) return null

  const W = 80
  const H = 18
  const PAD = 1
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1 // flat series still get a mid line
  const stepX = (W - 2 * PAD) / (values.length - 1)
  const points = values
    .map((v, i) => {
      const x = PAD + i * stepX
      const y = H - PAD - ((v - min) / range) * (H - 2 * PAD)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  const latest = values[values.length - 1]!
  const latestY = H - PAD - ((latest - min) / range) * (H - 2 * PAD)

  return (
    <svg
      className="perf-sparkline"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden
    >
      <polyline points={points} fill="none" />
      {hotAbove !== undefined && latest > hotAbove && (
        <circle className="perf-spark-hot" cx={W - PAD} cy={latestY} r={2} />
      )}
    </svg>
  )
}
