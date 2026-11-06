#!/usr/bin/env node
// Structure gate for the Agent Notes tree.
//
// Checks the closed lifecycle/class layout, filename dates, the three-line
// header block, status/folder agreement, required sections and their order,
// and relative links that resolve. When a `.zh.md` sibling exists, its status
// line and `##` section count must match the English note.
//
// Usage: node scripts/verify-agent-notes.mjs [notes-root]
// Default root: <repo>/.agents/notes, resolved from this script's location.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(process.argv[2] ?? join(here, '..', '.agents', 'notes'))
const LIFECYCLES = ['proposed', 'implemented', 'rejected']
const CLASSES = new Set(['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'])
const FILENAME = /^(\d{4})-(\d{2})-(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*$/
const ROOT_FILES = new Set(['readme.md', 'agents.md'])
const STATUS = {
  proposed: /^Status: proposed$/,
  implemented: /^Status: implemented$/,
  rejected: /^Status: rejected — \S.*$/,
}
const SKELETON = {
  proposed: ['Problem', 'Proposal', 'Alternatives considered', 'Acceptance criteria', 'Risks'],
  implemented: ['Problem', 'Decision', 'Alternatives considered', 'Consequences'],
  rejected: ['Problem', 'Proposal', 'Alternatives considered'],
}
const PROPOSAL_HEADINGS = ['Proposal', 'Plan', 'Migration plan', 'Acceptance criteria']

const problems = []
const textCache = new Map()
const treeCache = new Map()
const processor = unified().use(remarkParse)
let notes = 0

const rel = (file) => relative(root, file).split('\\').join('/')
const fail = (file, message) => problems.push(`${rel(file)}: ${message}`)

function read(file) {
  let text = textCache.get(file)
  if (text === undefined) {
    text = readFileSync(file, 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/^\uFEFF/, '')
    textCache.set(file, text)
  }
  return text
}

function treeOf(file) {
  let tree = treeCache.get(file)
  if (tree === undefined) {
    tree = processor.parse(read(file))
    treeCache.set(file, tree)
  }
  return tree
}

function validDate(year, month, day) {
  const date = new Date(0)
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  )
}

const textOf = (node) => node.value ?? (node.children ?? []).map(textOf).join('')

// Root-level `##` headings in document order. Parsing (rather than scanning
// lines) keeps fenced code, HTML comments, and ATX closing sequences correct.
function headingsOf(file) {
  return treeOf(file)
    .children.filter((node) => node.type === 'heading' && node.depth === 2)
    .map((node) => textOf(node).trim())
}

function collectLinks(node, out = []) {
  if (node.type === 'link' && typeof node.url === 'string' && node.url !== '') {
    out.push(node.url)
  }
  for (const child of node.children ?? []) collectLinks(child, out)
  return out
}

function checkLinks(file) {
  const dir = dirname(file)
  for (const url of collectLinks(treeOf(file))) {
    if (url.startsWith('#') || url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) {
      continue
    }
    const target = resolve(dir, url.split('#')[0])
    if (!existsSync(target)) fail(file, `broken relative link: ${url}`)
  }
}

// Resolve the English counterpart without assuming the extension's case: the
// gate must reach the same verdict on case-sensitive CI and on a developer's
// case-insensitive Windows/macOS checkout.
function findSibling(dir, stem) {
  const wanted = `${stem}.md`.toLowerCase()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase() === wanted) return join(dir, entry.name)
  }
  return join(dir, `${stem}.md`)
}

function headerStatus(text) {
  return text.split('\n')[2] ?? ''
}

function checkHeader(file, text) {
  const lines = text.split('\n')
  if (!/^# Agent Note: \S/.test(lines[0] ?? '')) {
    fail(file, 'line 1 must be "# Agent Note: <title>"')
  }
  if ((lines[1] ?? '').trim() !== '') {
    fail(file, 'line 2 must be blank')
  }
  if (lines.length < 4 || lines[3].trim() !== '') {
    fail(file, 'line 4 must be blank after the Status line')
  }
  return headerStatus(text)
}

function checkSkeleton(file, lifecycle) {
  const tree = treeOf(file)
  const ordered = headingsOf(file)
  const have = new Set(ordered)
  const required = SKELETON[lifecycle]

  // The body must open with `## Problem`; the header block contributes the
  // title and Status nodes, and an HTML comment is not body prose.
  const body = tree.children
    .slice(2)
    .filter((node) => !(node.type === 'html' && node.value.trim().startsWith('<!--')))
  const first = body[0]
  if (first && !(first.type === 'heading' && first.depth === 2 && textOf(first).trim() === 'Problem')) {
    fail(file, 'body must open with "## Problem"')
  }

  const missing = required.filter((name) => !have.has(name))
  for (const name of missing) fail(file, `missing "## ${name}"`)

  const seen = new Set()
  let duplicate = false
  for (const name of ordered) {
    if (!required.includes(name)) continue
    if (seen.has(name)) {
      fail(file, `duplicate "## ${name}"`)
      duplicate = true
    } else {
      seen.add(name)
    }
  }

  if (missing.length === 0 && !duplicate) {
    const present = ordered.filter((name) => required.includes(name))
    if (present.join('|') !== required.join('|')) {
      fail(file, `required sections must appear in order: ${required.join(' → ')}`)
    }
  }

  if (lifecycle === 'implemented') {
    for (const name of PROPOSAL_HEADINGS) {
      if (have.has(name)) {
        fail(file, `proposal-era "## ${name}" is not allowed in implemented/`)
      }
    }
  }
}

function checkNote(file, lifecycle) {
  notes += 1
  const text = read(file)
  const status = checkHeader(file, text)
  if (!STATUS[lifecycle].test(status)) {
    fail(file, `Status line disagrees with ${lifecycle}/: "${status}"`)
  }
  checkSkeleton(file, lifecycle)
  checkLinks(file)
}

function checkZh(file, englishFile) {
  const text = read(file)
  const status = checkHeader(file, text)
  if (!existsSync(englishFile)) {
    fail(file, `English sibling ${rel(englishFile)} is missing`)
    return
  }
  const englishStatus = headerStatus(read(englishFile))
  if (status !== englishStatus) {
    fail(file, `Status line must match the English sibling: "${englishStatus}"`)
  }
  const expected = headingsOf(englishFile).length
  const actual = headingsOf(file).length
  if (actual !== expected) {
    fail(file, `must mirror the English sibling's ${expected} "##" section(s); found ${actual}`)
  }
  checkLinks(file)
}

function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      fail(file, 'symlinks are not supported in the notes tree')
      continue
    }
    if (entry.isDirectory()) {
      const depth = rel(file).split('/').length
      if (depth === 1 && !LIFECYCLES.includes(entry.name)) {
        fail(file, `unknown lifecycle folder "${entry.name}"`)
        continue
      }
      if (depth === 2 && !CLASSES.has(entry.name)) {
        fail(file, `unknown class folder "${entry.name}"`)
        continue
      }
      if (depth >= 3) {
        fail(file, 'directories are not allowed below a class folder')
        continue
      }
      visit(file)
      continue
    }

    const lowerName = entry.name.toLowerCase()
    if (!entry.isFile() || !lowerName.endsWith('.md')) continue

    const parts = rel(file).split('/')
    if (parts.length === 1) {
      if (!ROOT_FILES.has(lowerName)) {
        fail(file, 'stray Markdown at the notes root; notes live under {lifecycle}/{class}/')
      }
      continue
    }
    if (parts.length !== 3) {
      fail(file, 'must live at {lifecycle}/{class}/yyyy-mm-dd-topic-title.md')
      continue
    }

    const lifecycle = parts[0]
    const name = parts[2]
    const isZh = lowerName.endsWith('.zh.md')
    const stem = isZh ? name.slice(0, -'.zh.md'.length) : name.slice(0, -3)
    const match = FILENAME.exec(stem)
    if (!match) {
      fail(file, 'filename must be yyyy-mm-dd-kebab-title.md')
      continue
    }
    if (!validDate(match[1], match[2], match[3])) {
      fail(file, `invalid date "${match[1]}-${match[2]}-${match[3]}"`)
      continue
    }
    if (isZh) {
      checkZh(file, findSibling(dir, stem))
      continue
    }
    checkNote(file, lifecycle)
  }
}

if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`agent-notes: ${root} not found or not a directory`)
  process.exitCode = 1
} else {
  visit(root)
  if (problems.length > 0) {
    console.error(`agent-notes: ${problems.length} problem(s)`)
    for (const problem of problems) console.error(`  ${problem}`)
    process.exitCode = 1
  } else {
    console.log(`agent-notes: ${notes} note(s) OK`)
  }
}
