#!/usr/bin/env node
// Cut a release: bump package.json, cut the CHANGELOG's [Unreleased] section
// into the new version, commit, tag, and push. The tag push hands off to
// .github/workflows/release.yml, which publishes to npm and creates the GitHub
// Release.
//
//   npm run release patch | minor | major
//   npm run release --version 1.2.3
//   npm run release --version 1.3.0-rc.1
//   npm run release minor --dry-run
//
// See RELEASING.md for the policy this enforces.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const root = process.cwd()
const argv = process.argv.slice(2)

const BUMPS = new Set(['major', 'minor', 'patch'])

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' })
}

function parseArgs(args) {
  const opts = {
    dryRun: false,
    push: true,
    verify: true,
    dirty: false,
    stale: false,
    branch: 'main',
    bump: null,
    version: null,
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--no-push') opts.push = false
    else if (arg === '--no-verify') opts.verify = false
    else if (arg === '--allow-dirty') opts.dirty = true
    else if (arg === '--allow-stale') opts.stale = true
    else if (arg === '--branch') opts.branch = args[++i]
    else if (arg.startsWith('--branch=')) opts.branch = arg.slice('--branch='.length)
    else if (arg === '--version') opts.version = args[++i]
    else if (arg.startsWith('--version=')) opts.version = arg.slice('--version='.length)
    else if (BUMPS.has(arg) && !opts.bump) opts.bump = arg
    else
      fail(
        `unknown argument "${arg}"\nusage: npm run release [major|minor|patch] [--version X.Y.Z[-pre]] ` +
          `[--dry-run] [--no-push] [--no-verify] [--branch NAME] [--allow-dirty] [--allow-stale]`,
      )
  }
  if (!opts.bump && !opts.version) fail('pass a bump (major|minor|patch) or --version X.Y.Z')
  if (opts.bump && opts.version) fail('pass either a bump or --version, not both')
  return opts
}

function nextVersion(current, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(current)
  if (!match) fail(`package.json version "${current}" is not a valid SemVer`)
  const isPrerelease = Boolean(match[4])
  let [major, minor, patch] = match.slice(1, 4).map(Number)
  if (bump === 'major') [major, minor, patch] = [major + 1, 0, 0]
  else if (bump === 'minor') [minor, patch] = [minor + 1, 0]
  // A patch bump on a prerelease finalizes it (1.2.3-rc.1 -> 1.2.3) rather
  // than skipping to 1.2.4 — the prerelease already named the target version.
  else if (!isPrerelease) patch += 1
  return `${major}.${minor}.${patch}`
}

/** A leading version with a `-suffix` is a prerelease. Its suffix drives the
 *  npm dist-tag and the GitHub `--prerelease` flag. */
function prereleaseOf(version) {
  const match = /^\d+\.\d+\.\d+-([0-9A-Za-z.-]+)$/.exec(version)
  return match ? match[1] : null
}

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function repoUrl(pkg) {
  const url =
    typeof pkg.repository === 'object' && pkg.repository !== null ? pkg.repository.url : pkg.repository
  if (typeof url !== 'string') return null
  const match = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?(?:[/#].*)?$/.exec(url)
  return match ? `https://github.com/${match[1]}` : null
}

/** Replace the `## [Unreleased]` heading with an empty Unreleased heading
 *  followed by the new version heading, so the previously-unreleased content
 *  becomes the version's section. Also appends the version's link reference.
 *  Throws when there is nothing to release. */
function cutChangelog(changelog, version, date, url) {
  const heading = /^## \[Unreleased\][^\n]*\n/m
  if (!heading.test(changelog)) fail('CHANGELOG.md has no "## [Unreleased]" heading')

  const afterHeading = changelog.replace(heading, '')
  const nextHeading = afterHeading.search(/^## \[/m)
  const section = (nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading)).trim()
  if (!section) fail('CHANGELOG.md [Unreleased] is empty — record the user-visible changes first')

  let out = changelog.replace(heading, `## [Unreleased]\n\n## [${version}] — ${date}\n`)

  if (!new RegExp(`^\\[${version.replace(/\./g, '\\.')}\\]:`, 'm').test(out)) {
    const link = `[${version}]: ${url}/releases/tag/v${version}`
    if (!url) fail('package.json repository is not a GitHub URL — cannot write the CHANGELOG link reference')
    const firstRef = out.search(/^\[[0-9]+\.[0-9]+\.[0-9]+\]:/m)
    out =
      firstRef === -1
        ? `${out.trimEnd()}\n\n${link}\n`
        : `${out.slice(0, firstRef)}${link}\n${out.slice(firstRef)}`
  }
  return out
}

const opts = parseArgs(argv)
const pkgPath = `${root}/package.json`
const changelogPath = `${root}/CHANGELOG.md`
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const version = opts.version ?? nextVersion(pkg.version, opts.bump)
const prerelease = prereleaseOf(version)
const tag = `v${version}`

if (opts.version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(opts.version))
  fail(`--version "${opts.version}" is not a plain or prerelease MAJOR.MINOR.PATCH`)

// ── Preflight ────────────────────────────────────────────────────────────────
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== opts.branch)
  fail(`on branch "${branch}", expected "${opts.branch}" (use --branch to override)`)
if (!opts.dirty && !opts.dryRun && git(['status', '--porcelain'])) {
  fail('working tree is dirty — commit or stash first (use --allow-dirty to override)')
}
if (opts.push && !opts.dryRun && !opts.stale) {
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', opts.branch], { cwd: root })
  } catch {
    console.warn(`release: could not fetch origin/${opts.branch} — skipping the up-to-date check`)
  }
  let remoteHead = null
  try {
    remoteHead = git(['rev-parse', `origin/${opts.branch}`])
  } catch {
    // No remote-tracking ref (no remote, or a brand-new branch) — nothing to compare.
  }
  if (remoteHead && remoteHead !== git(['rev-parse', 'HEAD'])) {
    fail(
      `local ${opts.branch} is not in sync with origin/${opts.branch} — push/pull first ` +
        '(use --allow-stale to override)',
    )
  }
}
if (!opts.dryRun) {
  try {
    git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`])
    fail(`tag ${tag} already exists`)
  } catch {
    // Expected: the tag does not exist yet.
  }
}

const url = repoUrl(pkg)
const nextChangelog = cutChangelog(readFileSync(changelogPath, 'utf8'), version, today(), url)
const nextPkg = `${JSON.stringify({ ...pkg, version }, null, 2)}\n`

if (opts.dryRun) {
  console.log(`release (dry run): ${pkg.version} -> ${version}  tag ${tag}  branch ${branch}`)
  console.log('\nCHANGELOG section that would ship:\n')
  const sectionStart = nextChangelog.indexOf(`## [${version}]`)
  const sectionEnd = nextChangelog.indexOf('\n## [', sectionStart + 1)
  console.log(nextChangelog.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd))
  process.exit(0)
}

if (opts.verify) {
  console.log(`release: running npm run verify (${pkg.version} -> ${version})`)
  run('npm', ['run', 'verify'])
}

const originalPkg = readFileSync(pkgPath, 'utf8')
const originalChangelog = readFileSync(changelogPath, 'utf8')

let committed = false
try {
  writeFileSync(pkgPath, nextPkg)
  writeFileSync(changelogPath, nextChangelog)
  run('git', ['add', 'package.json', 'CHANGELOG.md'])
  run('git', ['commit', '-m', `chore(release): ${tag}`])
  committed = true
  run('git', ['tag', '-a', tag, '-m', tag])
} catch {
  // Nothing was pushed yet. Put the two files back so a retry isn't blocked by
  // an already-cut (now empty) [Unreleased] section.
  if (!committed) {
    writeFileSync(pkgPath, originalPkg)
    writeFileSync(changelogPath, originalChangelog)
    try {
      run('git', ['reset', '-q', '--', 'package.json', 'CHANGELOG.md'])
    } catch {
      // Best-effort unstage.
    }
    console.error('release: aborted — working tree restored')
  } else {
    console.error(
      `release: commit ${tag} landed but tagging failed — finish with: git tag -a ${tag} -m ${tag}`,
    )
  }
  process.exit(1)
}

console.log(`release: committed and tagged ${tag}${prerelease ? ` (prerelease: ${prerelease})` : ''}`)

if (opts.push) {
  try {
    run('git', ['push', 'origin', branch])
    run('git', ['push', 'origin', tag])
  } catch {
    console.error(`release: push failed — ${tag} exists locally. Fix the remote, then run:`)
    console.error(`  git push origin ${branch}\n  git push origin ${tag}`)
    process.exit(1)
  }
  console.log(`release: pushed ${branch} and ${tag} — CI will publish and create the GitHub Release`)
} else {
  console.log(`release: --no-push set; run:\n  git push origin ${branch}\n  git push origin ${tag}`)
}
