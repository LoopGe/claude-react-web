// ONE-SHOT codemod: tokenize border-radius literals in src/styles (css mode)
// and src inline-style objects (tsx mode). Run then delete.
// Usage: node scripts/migrate-radii.mjs css|tsx
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const RADIUS_MAP = {
  '1px': 'var(--radius-2xs)',
  '2px': 'var(--radius-2xs)',
  '3px': 'var(--radius-3xs)',
  '4px': 'var(--radius-xs)',
  '5px': 'var(--radius-xs)',
  '6px': 'var(--radius-sm)',
  '7px': 'var(--radius-sm)',
  '8px': 'var(--radius-md)',
  '9px': 'var(--radius-lg)',
  '10px': 'var(--radius-lg)',
  '12px': 'var(--radius-xl)',
  '14px': 'var(--radius-2xl)',
  '18px': 'var(--radius-3xl)',
  '999px': 'var(--radius-pill)',
}

// Map a single CSS <length> token; 0 / unknown / !important pass through.
function mapLength(part) {
  if (part === '0') return '0'
  if (part === '50%') return 'var(--radius-circle)'
  if (RADIUS_MAP[part]) return RADIUS_MAP[part]
  return part
}

function rewrite(value) {
  return value.trim().split(/\s+/).map(mapLength).join(' ')
}

// border-radius: 4px | 6px 6px 0 0 | 50% !important | 999px
const CSS_RADIUS_RE = /(border-radius:\s*)([^;}]*)([;}])/g
// border-top-left-radius: 4px (corner-specific longhands)
const CSS_CORNER_RE = /(border-(?:top|bottom)-(?:left|right)-radius:\s*)([^;}]*)([;}])/g
// Inline style { borderRadius: 6 }
const TSX_NUM_RE = /(borderRadius:\s*)(\d+)(\s*[,}])/g
// Inline style { borderRadius: '50%' } or { borderRadius: '4px' }
const TSX_STR_RE = /(borderRadius:\s*['"])([^'"]+)(['"])/g

const [, , mode] = process.argv

function collect() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (st.isFile()) {
        const ext = extname(entry)
        if (mode === 'css' && ext === '.css') out.push(full)
        if (mode === 'tsx' && (ext === '.tsx' || ext === '.ts')) out.push(full)
      }
    }
  }
  walk('src')
  return out
}

const files = collect()
let changed = 0
for (const file of files) {
  const before = readFileSync(file, 'utf8')
  let after = before
  if (mode === 'css') {
    after = after
      .replace(CSS_RADIUS_RE, (_m, pre, value, end) => pre + rewrite(value) + end)
      .replace(CSS_CORNER_RE, (_m, pre, value, end) => pre + rewrite(value) + end)
  } else {
    after = after
      .replace(TSX_NUM_RE, (_m, pre, num, end) => {
        const token = RADIUS_MAP[`${num}px`]
        return token ? `${pre}'${token}'${end}` : _m
      })
      .replace(TSX_STR_RE, (_m, pre, val, quote) => {
        if (val === '50%') return `${pre}var(--radius-circle)${quote}`
        if (RADIUS_MAP[val]) return `${pre}${RADIUS_MAP[val]}${quote}`
        return _m
      })
  }
  if (after !== before) {
    writeFileSync(file, after)
    console.log('migrated', file)
    changed++
  }
}
console.log(`changed ${changed} files`)
