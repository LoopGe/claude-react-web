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

import { Hono } from 'hono'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve as resolvePath, sep } from 'node:path'

interface DirEntry {
  name: string
  path: string
  isDir: boolean
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
    const raw = c.req.query('path')
    const showHidden = c.req.query('hidden') === '1'
    if (!raw) return c.json({ error: 'path query param is required' }, 400)
    if (!isAbsolute(raw)) return c.json({ error: 'path must be absolute' }, 400)

    const path = resolvePath(raw)
    let entries: DirEntry[]
    try {
      const st = await stat(path)
      if (!st.isDirectory()) return c.json({ error: 'not a directory' }, 400)
      const dirents = await readdir(path, { withFileTypes: true })
      entries = dirents
        .filter((d) => (showHidden ? true : !d.name.startsWith('.')))
        .filter((d) => d.isDirectory())
        .map<DirEntry>((d) => ({
          name: d.name,
          path: resolvePath(path, d.name),
          isDir: true,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return c.json({ error: 'no such directory' }, 404)
      if (code === 'EACCES' || code === 'EPERM') return c.json({ error: 'permission denied' }, 403)
      return c.json({ error: (err as Error).message }, 500)
    }

    return c.json({
      path,
      parent: parentOf(path),
      entries,
    })
  })

  return app
}

function parentOf(p: string): string | null {
  const parent = resolvePath(p, '..')
  return parent === p ? null : parent
}
