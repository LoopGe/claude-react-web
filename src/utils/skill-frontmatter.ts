/** Lightweight client-side parser for SKILL.md frontmatter + body. */

export interface ParsedSkillContent {
  /** All frontmatter key-value pairs in original order. */
  frontmatter: Record<string, string>
  /** Markdown body after the closing `---`. */
  body: string
  /** Set when the content cannot be parsed as valid SKILL.md. */
  parseError?: string
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s
}

/** Strip surrounding single or double quotes from a scalar value. */
function parseScalar(raw: string): string {
  const t = raw.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * Parse a SKILL.md file content into structured frontmatter and body.
 *
 * Mirrors the server-side `parseSkillFrontmatter()` regex approach so
 * behaviour stays consistent, but returns *all* key-value pairs instead
 * of just `name` and `description`.
 */
export function parseSkillContent(raw: string): ParsedSkillContent {
  const normalized = stripBom(raw)
  const lines = normalized.split(/\r?\n/)

  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: raw, parseError: 'Content does not start with YAML frontmatter (---)' }
  }

  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (end < 0) {
    return { frontmatter: {}, body: raw, parseError: 'Missing closing --- for frontmatter' }
  }

  const frontmatter: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed)
    if (!match) continue
    frontmatter[match[1]] = parseScalar(match[2])
  }

  const body = lines.slice(end + 1).join('\n').trimStart()
  return { frontmatter, body }
}
