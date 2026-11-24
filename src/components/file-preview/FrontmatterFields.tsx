// YAML frontmatter field list for the markdown file preview. The yaml parser
// is a lazy chunk (nothing at startup); until it lands — and whenever the
// document is not a YAML mapping (parse failure, scalar, list) — the source
// renders verbatim, so the preview never blanks or crashes on bad metadata.
// An empty / whitespace-only block carries no metadata and renders nothing.

import { useEffect, useState } from 'react'

interface Field {
  key: string
  value: string
}

// Nested values (maps, lists, dates) stringify as indented JSON — readable,
// never `[object Object]`. Scalars render as their plain text.
function formatValue(value: unknown): string {
  if (value !== null && typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

interface Parsed {
  source: string
  fields: Field[] | null
}

export function FrontmatterFields({ source }: { source: string }) {
  // Keyed on the source so a refetch with new contents shows the verbatim
  // loading view again instead of the previous document's field list.
  const [parsed, setParsed] = useState<Parsed | null>(null)
  useEffect(() => {
    let active = true
    void import('yaml').then(({ parse }) => {
      if (!active) return
      let fields: Field[] | null = null
      try {
        const doc: unknown = parse(source)
        if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
          fields = Object.entries(doc).map(([key, value]) => ({ key, value: formatValue(value) }))
        }
      } catch {
        // Invalid YAML is a proven contract state: verbatim fallback.
      }
      setParsed({ source, fields })
    })
    return () => {
      active = false
    }
  }, [source])

  // Empty / whitespace-only source has no metadata to show — render nothing
  // rather than an empty bordered verbatim box. Placed after the hooks so the
  // hook order stays stable when a refetch empties (or fills) the block.
  if (source.trim() === '') return null

  const fields = parsed !== null && parsed.source === source ? parsed.fields : null
  if (fields === null) {
    return <pre className="frontmatter-verbatim">{source}</pre>
  }
  return (
    <dl className="frontmatter-fields">
      {fields.map(({ key, value }) => (
        <div key={key} className="frontmatter-field">
          <dt className="frontmatter-field-key">{key}</dt>
          <dd className="frontmatter-field-value">{value}</dd>
        </div>
      ))}
    </dl>
  )
}