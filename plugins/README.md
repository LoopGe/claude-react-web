# Claude React Web — App Plugin Marketplace

This repository is an **App Plugin marketplace** for [`claude-react-web`](https://github.com/gezelin/claude-react-web).
Add it as a marketplace in the web UI (Settings → App Plugins → Marketplace → Add) and install
plugins from it.

## Add this marketplace

In `claude-react-web`, open **Settings → App Plugins**, paste this repo's URL into the
Marketplace section, and click **Add**:

```
https://github.com/<owner>/<this-repo>.git
```

The host clones the repo, reads `app-plugins-marketplace.json`, and lists the plugins below.
Click **Install** on any plugin to install it (you consent to its declared permissions on
install), then **Enable** it.

## Plugins

| Name | Description |
|---|---|
| `translator` | Select text in a message → right-click → Translate. Uses the host's LLM to translate into a configurable target language and shows the result in a popover. Caches translations. |

## Marketplace format

A marketplace is a git repo containing:

- `app-plugins-marketplace.json` — the catalog: `{ "name", "appPlugins": [{ "name", "dir", "description", "version" }] }`.
- One subdirectory per plugin (the `dir`), each a valid App Plugin: a `crw-plugin.json` manifest
  + a pre-built `dist/service.mjs` (the background service). See the translator for a reference.

If `app-plugins-marketplace.json` is absent, the host auto-scans top-level subdirectories for a
`crw-plugin.json`. Plugin `dir`s are containment-checked (no `..` / absolute / symlink escape).

## For maintainers

This directory is also the **source of truth** for the official plugins, co-developed with the
`claude-react-web` host (it lives under the host repo's `plugins/`). The host repo's
`"files": ["dist"]` keeps it out of the published npm package — only the host bundle ships; this
directory is source-only there.

To publish this marketplace as its own GitHub repo (the recommended distribution — a small
plugin-only repo clones fast for users), split `plugins/` out of the host repo and push it:

```bash
# from the host repo root
git subtree split --prefix=plugins -b marketplace-main
git push <marketplace-repo-remote> marketplace-main:main
```

Re-run on every change to keep the marketplace repo in sync.
