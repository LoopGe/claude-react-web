// server/providers/native/tools/edit.ts
import { readFile, writeFile } from 'node:fs/promises'
import { ToolInputError, type ToolDef } from './types.js'
import { resolveAgainstCwd } from './read.js'

export const editTool: ToolDef<{
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}> = {
  name: 'Edit',
  description: 'Edit an existing UTF-8 text file by replacing literal text.',
  guidance: 'old_string must match exactly and appear exactly once unless replace_all is true.',
  promptOrder: 120,
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to edit, relative to the session working directory.' },
      old_string: { type: 'string', description: 'Literal text to replace.' },
      new_string: { type: 'string', description: 'Literal replacement text. Use an empty string to delete the match.' },
      replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async run(input, ctx) {
    const abs = resolveAgainstCwd(ctx.cwd, input.file_path)
    const content = await readFile(abs, 'utf-8').catch(() => {
      throw new ToolInputError(`file not found: ${input.file_path}`)
    })
    const count = content.split(input.old_string).length - 1
    if (count === 0) throw new ToolInputError('old_string not found in file')
    if (count > 1 && !input.replace_all) {
      throw new ToolInputError(`old_string appears ${count} times; pass replace_all or use a longer unique string`)
    }
    const next = input.replace_all
      ? content.replaceAll(input.old_string, input.new_string)
      : content.replace(input.old_string, input.new_string)
    await writeFile(abs, next, 'utf-8')
    return { text: `edited ${input.file_path}` }
  },
}
