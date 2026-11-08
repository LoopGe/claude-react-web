// server/providers/native/tools/write.ts
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveAgainstCwd } from './read.js'
import { type ToolDef } from './types.js'

export const writeTool: ToolDef<{ file_path: string; content: string }> = {
  name: 'Write',
  description: 'Create or fully replace a UTF-8 text file.',
  guidance: 'Prefer Edit over Write for existing files; Write creates or fully replaces a file.',
  promptOrder: 110,
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to write, relative to the session working directory.' },
      content: { type: 'string', description: 'Full file content.' },
    },
    required: ['file_path', 'content'],
  },
  async run(input, ctx) {
    const abs = resolveAgainstCwd(ctx.cwd, input.file_path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, input.content, 'utf-8')
    return { text: `wrote ${input.file_path} (${Buffer.byteLength(input.content, 'utf-8')} bytes)` }
  },
}
