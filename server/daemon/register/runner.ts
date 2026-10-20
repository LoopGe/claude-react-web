import { execFile } from 'node:child_process'
import type { CommandRunner } from './types.js'

export const execRunner: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err != null && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`required command not found: ${file}`))
        return
      }
      // execFile puts non-zero exits on err (with a numeric `code` property);
      // a process killed by a signal has no numeric code — surface 1 instead.
      const code = err == null ? 0 : (err as NodeJS.ErrnoException & { code?: number }).code
      resolve({ code: typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) })
    })
  })
