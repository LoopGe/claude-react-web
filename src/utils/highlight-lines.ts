// Per-line syntax highlighting for the numbered file preview.
//
// The whole text is highlighted ONCE via the shared lowlight instance, then the
// resulting hast tree is split into per-line subtrees. Splitting AFTER highlighting
// (rather than highlighting each line independently) is what keeps a token that
// spans several lines — a block comment, a template string — coloured on every
// line it covers: the open-element stack is carried across each '\n', so a span
// opened on line 3 and closed on line 5 is re-opened on lines 4 and 5. Per-line
// independent highlighting would break those tokens (and is explicitly rejected
// by the design).
//
// The line split matches NumberedCode exactly: `contents.split('\n')` with the
// phantom final empty segment dropped only when there is a trailing newline.
// Each returned node's rendered text, joined with '\n', reconstructs the source
// minus that phantom newline — copy reads the raw `contents`, so highlight markup
// never leaks into the clipboard.
//
// Memoization on (lang, contents) is the caller's job (NumberedCode).

import { Fragment, type ReactNode } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import type { Root, Element, RootContent, ElementContent } from 'hast'
import { lowlight, isRegisteredLanguage } from './lowlight-instance'

/** Insertion point for the current line: the innermost open clone's children, or
 *  the line root's children when no element is open. Text and element nodes are
 *  valid in both root and element children, so this union covers both arrays. */
type LineChildren = (RootContent | ElementContent)[]

/** Split a highlighted hast root into one root per source line, carrying the
 *  open-element stack across every newline in the text nodes. */
function splitIntoLines(root: Root): Root[] {
  const lineRoots: Root[] = [{ type: 'root', children: [] }]
  // Original elements currently open, outermost → innermost.
  const open: Element[] = []
  // Per-line clones parallel to `open`. On a newline these are rebuilt fresh so
  // each line owns its own element children (the originals span multiple lines).
  const clones: Element[] = []

  const target = (): LineChildren =>
    clones.length > 0
      ? clones[clones.length - 1].children
      : lineRoots[lineRoots.length - 1].children

  const appendText = (value: string): void => {
    if (value !== '') target().push({ type: 'text', value })
  }

  const newLine = (): void => {
    const line: Root = { type: 'root', children: [] }
    lineRoots.push(line)
    // Re-open a fresh clone of every still-open element on the new line.
    clones.length = 0
    let parent: LineChildren = line.children
    for (const el of open) {
      const clone: Element = {
        type: 'element',
        tagName: el.tagName,
        properties: el.properties,
        children: [],
      }
      parent.push(clone)
      clones.push(clone)
      parent = clone.children
    }
  }

  const walk = (node: RootContent): void => {
    if (node.type === 'text') {
      const parts = node.value.split('\n')
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) newLine()
        appendText(parts[i])
      }
      return
    }
    if (node.type === 'element') {
      const clone: Element = {
        type: 'element',
        tagName: node.tagName,
        properties: node.properties,
        children: [],
      }
      target().push(clone)
      open.push(node)
      clones.push(clone)
      for (const child of node.children) walk(child)
      open.pop()
      clones.pop()
    }
    // lowlight emits only root / element / text; other node types carry no text.
  }

  for (const child of root.children) walk(child)
  return lineRoots
}

function renderLine(line: Root): ReactNode {
  return toJsxRuntime(line, {
    Fragment,
    jsx,
    jsxs,
    elementAttributeNameCase: 'react',
    stylePropertyNameCase: 'css',
  })
}

/** Highlight `contents` and return one ReactNode per source line, in order.
 *  Unknown / absent / unregistered `lang` yields plain per-line text nodes (no
 *  throw). The line count matches NumberedCode's split exactly. */
export function highlightLines(lang: string | undefined, contents: string): ReactNode[] {
  const raw = contents.split('\n')
  // A trailing newline produces a phantom final segment; the file has no such
  // line (same rule as NumberedCode).
  const lines = raw.length > 1 && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw

  if (lang == null || !isRegisteredLanguage(lang)) {
    return lines
  }

  const root = lowlight.highlight(lang, contents)
  const lineRoots = splitIntoLines(root)
  // highlight.js preserves every character, so the split yields exactly
  // `raw.length` line roots; trim to the source line count (drops the phantom
  // trailing line when present).
  return lineRoots.slice(0, lines.length).map(renderLine)
}
