#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = process.cwd()
const targetDir = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'dist/client'
const json = process.argv.includes('--json')
const absoluteTarget = join(root, targetDir)
const interestingExtensions = new Set(['.js', '.css', '.html', '.svg', '.json', '.wasm'])

function walk(dir) {
  const entries = []
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      entries.push(...walk(fullPath))
    } else if (stat.isFile()) {
      entries.push(fullPath)
    }
  }
  return entries
}

function extensionOf(file) {
  const match = /\.[^.]+$/.exec(file)
  return match ? match[0].toLowerCase() : ''
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = units.shift()
  while (value >= 1024 && units.length > 0) {
    value /= 1024
    unit = units.shift()
  }
  return value.toFixed(value >= 10 ? 1 : 2) + ' ' + unit
}

function pad(text, width) {
  return String(text).padEnd(width, ' ')
}

if (!existsSync(absoluteTarget)) {
  console.error('Bundle output not found: ' + targetDir)
  console.error('Run npm run build:client first, or use npm run analyze:bundle.')
  process.exit(1)
}

const files = walk(absoluteTarget)
  .filter((file) => interestingExtensions.has(extensionOf(file)))
  .map((file) => {
    const bytes = readFileSync(file)
    return {
      file: relative(root, file).replace(/\\/g, '/'),
      type: extensionOf(file).slice(1) || 'other',
      bytes: bytes.length,
      gzipBytes: gzipSync(bytes).length,
    }
  })
  .sort((a, b) => b.bytes - a.bytes)

const totals = files.reduce((acc, file) => {
  acc.bytes += file.bytes
  acc.gzipBytes += file.gzipBytes
  acc.byType[file.type] ??= { bytes: 0, gzipBytes: 0, count: 0 }
  acc.byType[file.type].bytes += file.bytes
  acc.byType[file.type].gzipBytes += file.gzipBytes
  acc.byType[file.type].count += 1
  return acc
}, { bytes: 0, gzipBytes: 0, byType: {} })

if (json) {
  console.log(JSON.stringify({ targetDir, totals, files }, null, 2))
  process.exit(0)
}

console.log('Bundle analysis for ' + targetDir)
console.log('Total: ' + formatBytes(totals.bytes) + ' raw / ' + formatBytes(totals.gzipBytes) + ' gzip across ' + files.length + ' files')
console.log('')
console.log('By type:')
for (const [type, item] of Object.entries(totals.byType).sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log('  ' + pad(type, 5) + ' ' + pad(item.count, 4) + ' ' + pad(formatBytes(item.bytes), 10) + formatBytes(item.gzipBytes) + ' gzip')
}
console.log('')
console.log('Largest files:')
console.log('  ' + pad('raw', 10) + ' ' + pad('gzip', 10) + ' file')
for (const file of files.slice(0, 20)) {
  console.log('  ' + pad(formatBytes(file.bytes), 10) + ' ' + pad(formatBytes(file.gzipBytes), 10) + ' ' + file.file)
}
