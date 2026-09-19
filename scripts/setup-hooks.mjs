#!/usr/bin/env node
// Point git at the repo's `.githooks/` directory on `npm install`. No-op when
// this isn't a git checkout (e.g. installing the published tarball, where
// `prepare` doesn't run anyway) and never fails the install — CI enforces
// commitlint on PRs regardless.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (!existsSync('.git')) process.exit(0)

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' })
} catch {
  // git unavailable or a read-only checkout — carry on.
}
