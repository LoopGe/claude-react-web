#!/usr/bin/env node
// Print the CHANGELOG.md section for a single released version, so the release
// workflow can use it verbatim as the GitHub Release body.
//
//   node scripts/changelog-section.mjs 0.8.0
//   node scripts/changelog-section.mjs v0.8.0   # leading v is ignored
//
// Exits non-zero when the version has no section. The caller (the release
// workflow) treats that as a failure: shipping a GitHub Release with no notes
// is worse than failing the job.

import { readFileSync } from 'node:fs'

const version = process.argv[2]?.replace(/^v/, '')
if (!version) {
  console.error('usage: node scripts/changelog-section.mjs <version>')
  process.exit(2)
}

const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n')
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
if (start === -1) {
  console.error(`changelog-section: no "## [${version}]" section in CHANGELOG.md`)
  process.exit(1)
}

let end = lines.length
for (let i = start + 1; i < lines.length; i += 1) {
  if (lines[i].startsWith('## [')) {
    end = i
    break
  }
}

const body = lines
  .slice(start + 1, end)
  .join('\n')
  .trim()
if (!body) {
  console.error(`changelog-section: "## [${version}]" section is empty`)
  process.exit(1)
}

process.stdout.write(body + '\n')
