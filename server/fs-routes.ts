// Directory browsing for the "pick a working directory" UI.
//
// This is not a general file-browser API — we only list sub-directories,
// refuse to return file contents, and apply minimal hardening:
//   - path is normalized (resolves .., removes ./)
//   - hidden dirs (starting with .) hidden by default, toggle via ?hidden=1
//   - no symlink following beyond the immediate read (Node's readdir follows
//     the outer path naturally; we check each entry's Dirent.isDirectory())
//
// Since the server is intended to run locally as the same user as the person
// driving the browser, this is treated as an authorization-free "show me my
// own home" tool, not a sandboxed file API.

import { Hono, type Context } from 'hono'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve as resolvePath, sep } from 'node:path'

interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

/** Validate that a `path` query param is present and absolute.
 *  Returns the resolved path or an error Response. */
function requireAbsPath(raw: string | undefined, c: Context): { path: string } | { error: Response } {
  if (!raw) return { error: c.json({ error: 'path query param is required' }, 400) }
  if (!isAbsolute(raw)) return { error: c.json({ error: 'path must be absolute' }, 400) }
  return { path: resolvePath(raw) }
}

/** Map a filesystem errno to the appropriate JSON error response. */
function fsError(c: Context, err: unknown, notFoundMsg: string) {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOENT') return c.json({ error: notFoundMsg }, 404)
  if (code === 'EACCES' || code === 'EPERM') return c.json({ error: 'permission denied' }, 403)
  return c.json({ error: (err as Error).message }, 500)
}

export function buildFsRouter(): Hono {
  const app = new Hono()

  // Default starting points for the picker.
  app.get('/home', (c) => {
    return c.json({
      home: homedir(),
      cwd: process.cwd(),
      sep,
    })
  })

  // List a directory's sub-directories.
  app.get('/list', async (c) => {
    const showHidden = c.req.query('hidden') === '1'
    const check = requireAbsPath(c.req.query('path'), c)
    if ('error' in check) return check.error
    const { path } = check

    let entries: DirEntry[]
    try {
      const st = await stat(path)
      if (!st.isDirectory()) return c.json({ error: 'not a directory' }, 400)
      const dirents = await readdir(path, { withFileTypes: true })
      entries = dirents
        .filter((d) => (showHidden || !d.name.startsWith('.')) && d.isDirectory())
        .map<DirEntry>((d) => ({
          name: d.name,
          path: resolvePath(path, d.name),
          isDir: true,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch (err) {
      return fsError(c, err, 'no such directory')
    }

    return c.json({
      path,
      parent: parentOf(path),
      entries,
    })
  })

  // Resolve a path to its containing directory. Useful for the
  // drag-to-new-session UX: the browser's file drop gives us a path
  // that might be either a directory or a file; the frontend sends
  // it here and gets back a valid cwd (the file's dirname, if the
  // path points at a file). Also returns isDirectory so the caller
  // can tell us if it's already a directory.
  app.get('/resolve-cwd', async (c) => {
    const check = requireAbsPath(c.req.query('path'), c)
    if ('error' in check) return check.error
    const { path } = check

    try {
      const st = await stat(path)
      if (st.isDirectory()) {
        return c.json({ cwd: path, resolvedFromFile: false })
      }
      // It's a regular file / symlink / etc. — walk one level up.
      return c.json({ cwd: dirname(path), resolvedFromFile: true })
    } catch (err) {
      return fsError(c, err, 'no such path')
    }
  })

  return app
}

function parentOf(p: string): string | null {
  const parent = resolvePath(p, '..')
  return parent === p ? null : parent
}
