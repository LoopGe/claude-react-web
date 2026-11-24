// YAML frontmatter split for the markdown file preview. A leading `---` line
// opens a metadata block ONLY when a closing `---` (or `...`) delimiter line
// exists — a lone leading horizontal rule is markdown, not frontmatter, and
// must pass through untouched. CRLF input is normalized to LF; when no block
// is found the ORIGINAL contents are returned verbatim.

// The inner group is lazy and must end on a newline (or be absent, for an
// empty block), so the closing delimiter can only match at a line start.
const FRONTMATTER_RE = /^---\n([\s\S]*?\n)?(?:---|\.\.\.)(?:\n|$)/

export interface FrontmatterSplit {
  /** Inner block text (delimiters excluded), or null when no block exists. */
  frontmatter: string | null
  /** The markdown body after the block — the full contents when null. */
  body: string
}

export function splitFrontmatter(contents: string): FrontmatterSplit {
  const text = contents.replace(/\r\n/g, '\n')
  const match = FRONTMATTER_RE.exec(text)
  if (!match) return { frontmatter: null, body: contents }
  const inner = match[1] ?? ''
  return {
    frontmatter: inner.endsWith('\n') ? inner.slice(0, -1) : inner,
    body: text.slice(match[0].length),
  }
}