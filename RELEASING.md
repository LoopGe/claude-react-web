# Releasing

`claude-react-web` ships as a single npm package plus a GitHub Release. This
document is the contract for how a version goes out — follow it and the npm
package, the git tag, the GitHub Release, and the in-app updater stay in sync.

## Ground rules

- **Semantic Versioning.** `MAJOR.MINOR.PATCH`.
  - While on `0.x`, a breaking change bumps **minor** (the accepted `0.x`
    convention); features bump minor, fixes bump patch.
  - Pre-releases are `X.Y.Z-rc.N`, `-beta.N`, etc., cut with an explicit
    version (`npm run release --version 0.8.0-rc.1`). The tooling publishes
    them under the suffix as the npm dist-tag (never `latest`) and marks the
    GitHub Release **pre-release**, so the in-app updater ignores them.
- **`package.json.version` is the single source of truth.** It is inlined into
  the server bundle at **build time** (`server/update-checker.ts` reads it via a
  JSON import), so the version must be bumped **before** `npm run build` /
  `npm publish`. The release tooling does this for you.
- **Tags are `vX.Y.Z`.** One convention, always the `v` prefix. The release-notes
  reader strips a leading `v`, so both forms parse, but new tags use `v`.
  (Historical tags mixed the two; do not retag published releases — just be
  consistent from the next release on.)
- **Every release is a published GitHub Release**, not just an npm publish. The
  in-app _What's New_ dialog reads the GitHub Releases API and skips
  drafts/prereleases. Publish both, or the updater tells users about a version
  with no notes.
- **Keep a Changelog.** User-visible changes are recorded in `CHANGELOG.md`
  under `[Unreleased]` as the PR lands. The release tooling cuts that section
  into the new version's entry. A release with an empty `[Unreleased]` is
  rejected — if nothing is listed, there is nothing to release.

## Commit convention

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): subject`, e.g. `fix(git-panel): keep the diff open on refresh`.

Allowed types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`,
`ci`, `chore`, `style`, `revert`. This is enforced on PRs by CI
(`commitlint`) and locally by the `commit-msg` git hook installed on
`npm install`.

Bump type is a judgement call, not an automatic commit-derivation: use the
CHANGELOG as the record of intent.

## The fast path

```bash
# 1. Land everything on main, with [Unreleased] filled in.
git switch main && git pull

# 2. Cut the release. This runs `npm run verify`, bumps package.json, cuts the
#    CHANGELOG, commits `chore(release): vX.Y.Z`, tags, and pushes both.
npm run release minor        # or: patch | major | --version 1.2.3
npm run release --version 0.8.0-rc.1   # prerelease

# 3. CI takes over: .github/workflows/release.yml publishes to npm (with
#    provenance) and creates the GitHub Release from the CHANGELOG section.
```

Useful flags:

| Flag              | Effect                                                               |
| ----------------- | -------------------------------------------------------------------- |
| `--version X.Y.Z` | Explicit version (`X.Y.Z` or `X.Y.Z-rc.N`) instead of a bump keyword |
| `--dry-run`       | Print the plan (next version, CHANGELOG section) without writing     |
| `--no-push`       | Commit and tag locally, skip `git push`                              |
| `--no-verify`     | Skip `npm run verify` (emergency only)                               |
| `--branch <name>` | Override the expected branch (default `main`)                        |
| `--allow-dirty`   | Skip the clean-working-tree gate                                     |
| `--allow-stale`   | Skip the "in sync with origin" check                                 |

`npm run release` refuses to run when: the working tree is dirty, you are not on
the expected branch, the tag already exists, `[Unreleased]` is empty, or local
`main` is out of sync with `origin/main`. If it fails after committing but
before tagging it tells you the exact `git tag` to finish with, and a failure
before the commit restores both files.

## Manual fallback

If you have to release by hand:

```bash
npm run verify
# edit package.json version and cut CHANGELOG.md [Unreleased] -> [X.Y.Z] — DATE
git commit -am "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main
git push origin vX.Y.Z
# CI does the npm publish + GitHub Release. To do it yourself:
npm publish --provenance --access public
node scripts/changelog-section.mjs X.Y.Z > /tmp/notes.md
gh release create vX.Y.Z --title vX.Y.Z --notes-file /tmp/notes.md
```

## CI/CD

`.github/workflows/release.yml` triggers on a pushed `v*` tag (or manually via
`workflow_dispatch` with the tag as input). It:

1. checks out with full history and verifies the tag matches
   `package.json.version` (a mismatch aborts — otherwise the baked-in version
   lie propagates to every install),
2. runs `npm ci && npm run verify`,
3. publishes to npm with `--provenance --access public` (and `--tag <suffix>`
   for a prerelease, so it never claims `latest`),
4. creates the GitHub Release from the matching `CHANGELOG.md` section,
   marked pre-release when the version has a suffix.

The workflow is **not idempotent**: `npm publish` rejects an already-published
version and `gh release create` rejects an existing release. If step 3 succeeds
and step 4 fails, re-run only the release-creation step locally
(`gh release create …`) rather than re-running the whole workflow.

### One-time setup (repo owner)

- **npm auth**: either add a repo secret `NPM_TOKEN` with publish rights, or —
  preferred — configure [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
  for `LoopGe/claude-react-web` and the workflow filename, then delete the
  `NODE_AUTH_TOKEN` line from the publish step. `id-token: write` is already
  granted for provenance.
- **Approval gate (optional)**: create a GitHub environment named
  `npm-publish` and add required reviewers. The workflow already targets it, so
  the publish step waits for approval.
- **Branch protection**: require the `CI` status checks on `main`.

## Desktop builds

`desktop/electron-builder.yml` reads `package.json.version`, so a desktop build
from a released tag inherits the right version automatically. Signing and
notarization are a separate, manual step and are intentionally out of this
workflow.
